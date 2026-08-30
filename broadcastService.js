// broadcastService.js
//
// Core logic for sending a personalized push notification to every eligible
// user. Used by BOTH send-broadcast.js (manual CLI) and the /admin/broadcast
// Express route below — neither of those files re-implements any of this,
// they just call sendBroadcast().
//
// Requires:
//   npm install @supabase/supabase-js
//   Node 18+ (for global fetch) — if your server runs an older Node,
//   `npm install node-fetch` and uncomment the require at the top.
//
// Environment variables needed (set these in your backend's .env / host
// config — NEVER put the service role key in the mobile app):
//   SUPABASE_URL=https://<your-project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=<service role key, from Supabase dashboard>

// const fetch = require("node-fetch"); // uncomment if Node < 18
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_SIZE = 95; // Expo's documented max is 100 — staying a
                             // little under it, not at the exact edge.
const DELAY_BETWEEN_BATCHES_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function personalize(template, username) {
  return template.replace(/\{username\}/g, username || "there");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Sends `title`/`bodyTemplate` (bodyTemplate may contain {username}) to
 * every profile with a push token who hasn't opted out. Returns a summary
 * object and also logs the campaign into broadcast_notifications.
 *
 * @param {string} title
 * @param {string} bodyTemplate  e.g. "Hey {username}, meet new friends today! 🌍"
 * @param {string|null} sentBy   profile id of whoever triggered this, or null for the CLI script
 * @param {object} [options]
 * @param {string[]} [options.testUserIds]  if provided, ONLY these user ids
 *   are sent to — everyone else is skipped, regardless of their push
 *   token/opt-in status. Use this to safely test the whole pipeline
 *   against your own account before ever sending to real users. Omit
 *   entirely (or pass nothing) for a normal, real, everyone-eligible send.
 */
async function sendBroadcast(title, bodyTemplate, sentBy = null, options = {}) {
  const { testUserIds } = options;

  if (!title?.trim() || !bodyTemplate?.trim()) {
    throw new Error("title and bodyTemplate are both required");
  }

  // 1. Log the campaign as "running" immediately, so even a crash partway
  //    through leaves a record instead of silently vanishing.
  const { data: campaign, error: campaignError } = await supabase
    .from("broadcast_notifications")
    .insert({
      title,
      body_template: bodyTemplate,
      sent_by: sentBy,
      status: "running",
      // Test sends are tagged in the title so they're unmistakable in the
      // campaign log later — never confused with a real campaign.
      ...(testUserIds?.length ? { title: `[TEST] ${title}` } : {}),
    })
    .select()
    .single();

  if (campaignError) {
    throw new Error(`Could not create campaign record: ${campaignError.message}`);
  }

  try {
    // 2. Pull recipients. In test mode, this is narrowed to just the ids
    //    you passed in — everyone else is completely untouched.
    let query = supabase.from("profiles").select("id, username, push_token");

    if (testUserIds?.length) {
      query = query.in("id", testUserIds);
    } else {
      query = query.not("push_token", "is", null).eq("push_notifications_enabled", true);
    }

    const { data: recipients, error: fetchError } = await query;

    if (fetchError) throw new Error(`Could not fetch recipients: ${fetchError.message}`);

    const eligible = (recipients || []).filter((r) => !!r.push_token);
    const batches = chunk(eligible, EXPO_BATCH_SIZE);

    let successCount = 0;
    let failCount = 0;
    const deadTokenUserIds = [];

    for (const batch of batches) {
      const messages = batch.map((r) => ({
        to: r.push_token,
        sound: "default",
        title,
        body: personalize(bodyTemplate, r.username),
        data: { type: "broadcast", campaignId: campaign.id },
      }));

      let tickets = [];
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify(messages),
        });
        const json = await res.json();
        tickets = json?.data || [];
      } catch (batchErr) {
        // Whole batch failed at the network level — count everyone in it
        // as failed and move on; one bad batch shouldn't kill the run.
        failCount += batch.length;
        console.error("Broadcast batch request failed:", batchErr.message);
        await sleep(DELAY_BETWEEN_BATCHES_MS);
        continue;
      }

      tickets.forEach((ticket, i) => {
        const recipient = batch[i];
        if (ticket.status === "ok") {
          successCount++;
        } else {
          failCount++;
          // A dead/uninstalled-app token — clean it up so future
          // broadcasts (and real notifications) stop wasting a send on it.
          if (ticket.details?.error === "DeviceNotRegistered") {
            deadTokenUserIds.push(recipient.id);
          } else {
            console.log(`Push failed for user ${recipient.id}:`, ticket.message || ticket);
          }
        }
      });

      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }

    if (deadTokenUserIds.length > 0) {
      await supabase
        .from("profiles")
        .update({ push_token: null })
        .in("id", deadTokenUserIds);
    }

    await supabase
      .from("broadcast_notifications")
      .update({
        total_recipients: eligible.length,
        successful_sends: successCount,
        failed_sends: failCount,
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    return {
      campaignId: campaign.id,
      totalRecipients: eligible.length,
      successCount,
      failCount,
      deadTokensCleared: deadTokenUserIds.length,
    };
  } catch (err) {
    await supabase
      .from("broadcast_notifications")
      .update({
        status: "failed",
        error_message: err.message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);
    throw err;
  }
}

module.exports = { sendBroadcast };
