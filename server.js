require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const fetch    = require("node-fetch");
const { AccessToken } = require("livekit-server-sdk");
const Brevo    = require("@getbrevo/brevo");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Env ────────────────────────────────────────────────────────────────────
const LIVEKIT_API_KEY        = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET     = process.env.LIVEKIT_API_SECRET;
const TOKEN_ENDPOINT_SECRET  = process.env.TOKEN_ENDPOINT_SECRET;
const SUPABASE_URL           = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Warning: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

// ── Supabase admin client ──────────────────────────────────────────────────
const supabaseAuthAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Brevo email ────────────────────────────────────────────────────────────
const apiInstance = new Brevo.TransactionalEmailsApi();
apiInstance.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);
const FROM_EMAIL = process.env.OTP_FROM_EMAIL || "TalkSwap <otp@talkswap.in>";

// ── Supabase REST helpers ──────────────────────────────────────────────────
const DB_HEADERS = {
  apikey:        SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function dbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: { ...DB_HEADERS, "Content-Type": undefined },
  });
  if (!res.ok) return null;
  return res.json();
}

async function dbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: { ...DB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`dbPost ${path} error:`, text);
  }
  return res.ok;
}

async function insertNotification({ userId, senderId, type, title, body, referenceId }) {
  try {
    await dbPost("/notifications", {
      user_id:      userId,
      sender_id:    senderId || null,
      type,
      title:        title || null,
      body,
      reference_id: referenceId || null,
      is_read:      false,
    });
  } catch (err) {
    console.warn("insertNotification error:", err.message);
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAppSecret(req, res, next) {
  if (!TOKEN_ENDPOINT_SECRET) return next();
  if (req.headers["x-app-secret"] !== TOKEN_ENDPOINT_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ──────────────────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "talkswap-backend", ts: Date.now() });
});

// ── LiveKit token ──────────────────────────────────────────────────────────
app.post("/token", requireAppSecret, async (req, res) => {
  try {
    const { roomName, userId, userName } = req.body || {};
    if (!roomName || !userId) {
      return res.status(400).json({ error: "roomName and userId are required" });
    }
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(userId),
      name:     String(userName || userId),
      ttl:      "2h",
    });
    at.addGrant({ roomJoin: true, room: String(roomName), canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    return res.json({ token, roomName: String(roomName), identity: String(userId) });
  } catch (err) {
    console.error("token error:", err);
    return res.status(500).json({ error: "Failed to create token" });
  }
});

// ── Raw push (direct Expo push, no DB) ────────────────────────────────────
app.post("/send-push", requireAppSecret, async (req, res) => {
  try {
    const { token, title, body, data } = req.body || {};
    if (!token || !title || !body) {
      return res.status(400).json({ error: "token, title, and body are required" });
    }
    const r = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: token, sound: "default", title, body, data: data || {}, priority: "high" }),
    });
    const result = await r.json();
    return res.status(r.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error("send-push error:", err);
    return res.status(500).json({ error: "Failed to send push" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  /notify  — the main notification endpoint
//  Fixed:
//    ✅ Seen check  — skips push if message already read (WhatsApp behaviour)
//    ✅ Online check — skips push if receiver is actively in the app
//    ✅ Unread grouping — "deepu10 (3 new messages)" like WhatsApp/Instagram
//    ✅ Professional copy per message type (photo / voice / video / text)
//    ✅ No Reply/Like action buttons (removed categoryId entirely)
//    ✅ Saves in-app notification regardless of push skip reason
// ────────────────────────────────────────────────────────────────────────────
app.post("/notify", requireAppSecret, async (req, res) => {
  try {
    const {
      receiverId,
      senderId,
      type,
      title,
      body,
      referenceId = null,
      pushData    = {},
    } = req.body || {};

    if (!receiverId || !type || !body) {
      return res.status(400).json({ error: "receiverId, type, and body are required" });
    }

    // ── 1. Fetch receiver profile ─────────────────────────────────────────
    const profiles = await dbGet(
      `/profiles?id=eq.${receiverId}` +
      `&select=push_token,push_notifications,message_notifications,` +
      `follow_notifications,voice_room_notifications,call_notifications,` +
      `missed_call_notifications,is_online`
    );
    const receiver = profiles?.[0] || null;

    // ── 2. Notification preference check ─────────────────────────────────
    let pushAllowed = receiver?.push_notifications !== false;
    if (type === "message"          && receiver?.message_notifications    === false) pushAllowed = false;
    if (["follow","follow_request","follow_back"].includes(type)
                                    && receiver?.follow_notifications     === false) pushAllowed = false;
    if (type === "voice_room_invite"&& receiver?.voice_room_notifications === false) pushAllowed = false;
    if (type === "incoming_call"    && receiver?.call_notifications       === false) pushAllowed = false;
    if (type === "missed_call"      && receiver?.missed_call_notifications=== false) pushAllowed = false;

    // ── 3. WhatsApp seen check — skip push if message already read ────────
    if (type === "message" && pushAllowed && pushData?.messageId) {
      try {
        const seenRows = await dbGet(
          `/messages?id=eq.${pushData.messageId}&select=seen`
        );
        if (seenRows?.[0]?.seen === true) {
          // Message is already open/seen — save in-app notif but no push
          void insertNotification({ userId: receiverId, senderId, type, title, body, referenceId });
          return res.json({ success: true, push: false, reason: "already_seen" });
        }
      } catch (_) { /* if check fails, fall through and send push anyway */ }
    }

    // ── 4. Online check — skip push if receiver is in the app ────────────
    // is_online is maintained by _layout.tsx AppState heartbeat (25 s interval).
    // If they're online they'll see the message via Realtime instantly.
    if (type === "message" && pushAllowed && receiver?.is_online === true) {
      void insertNotification({ userId: receiverId, senderId, type, title, body, referenceId });
      return res.json({ success: true, push: false, reason: "user_online" });
    }

    // ── 5. Unread count — WhatsApp/Instagram grouping ─────────────────────
    // Query how many unseen messages exist from this sender in this conversation.
    // If > 1 we include the count in the notification title so the user sees
    // "deepu10 (3 new messages)" instead of three separate notifications.
    let unreadCount = 1;
    const convId = pushData?.conversationId || referenceId;
    if (type === "message" && convId && senderId) {
      try {
        const unreadRows = await dbGet(
          `/messages?conversation_id=eq.${convId}` +
          `&sender_id=eq.${senderId}&seen=is.false&select=id`
        );
        unreadCount = Array.isArray(unreadRows) ? Math.max(1, unreadRows.length) : 1;
      } catch (_) { /* use default of 1 */ }
    }

    // ── 6. Build professional notification copy ───────────────────────────
    let finalTitle = title  || "TalkSwap";
    let finalBody  = body;

    if (type === "message") {
      const senderName  = pushData?.senderName  || title || "Someone";
      const msgType     = pushData?.messageType || "text";
      const msgPreview  = pushData?.messagePreview || body || "";

      // Title: sender name, with count when multiple unread
      finalTitle = unreadCount > 1
        ? `${senderName} (${unreadCount} new messages)`
        : senderName;

      // Body: format by content type
      switch (msgType) {
        case "image": finalBody = "📷  Photo";        break;
        case "video": finalBody = "🎥  Video";        break;
        case "voice": finalBody = "🎤  Voice message"; break;
        default:
          finalBody = msgPreview.replace(/\n/g, " ").trim();
          if (finalBody.length > 100) finalBody = finalBody.substring(0, 97) + "…";
          if (!finalBody) finalBody = "Sent you a message";
      }
    } else if (type === "follow")         { finalTitle = title || "New follower";   }
    else if (type === "follow_request")   { finalTitle = title || "Follow request"; }
    else if (type === "incoming_call")    { finalTitle = "📞  Incoming call";       }
    else if (type === "missed_call")      { finalTitle = "📵  Missed call";         }
    else if (type === "voice_room_invite"){ finalTitle = title || "Voice room invite"; }

    // ── 7. Save in-app notification (always, even when push is skipped) ────
    const notifPromise = insertNotification({
      userId:      receiverId,
      senderId:    senderId || null,
      type,
      title:       finalTitle,
      body:        finalBody,
      referenceId,
    });

    // ── 8. Build and send Expo push ───────────────────────────────────────
    let pushResult = false;

    if (pushAllowed && receiver?.push_token) {
      const payload = {
        to:        receiver.push_token,
        sound:     "default",
        title:     finalTitle,
        body:      finalBody,
        data: {
          type,
          referenceId,
          senderId,
          conversationId: convId || null,
          messageId:      pushData?.messageId  || null,
          senderName:     pushData?.senderName || finalTitle,
          ...pushData,
        },
        priority:  "high",
        // "messages" channel is registered in lib/push.ts with HIGH importance
        // so it bypasses DND on Android and shows heads-up banners
        channelId: "messages",
        // No categoryId — Reply/Like action buttons removed
      };

      try {
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        });
        pushResult = await pushRes.json();
      } catch (err) {
        console.warn("Expo push failed:", err.message);
      }
    }

    await notifPromise;

    return res.json({ success: true, notification: true, push: pushResult });

  } catch (err) {
    console.error("notify error:", err);
    return res.status(500).json({ error: "Failed to notify user" });
  }
});

// ── Test notification (dev only) ────────────────────────────────────────────
app.post("/test-notification", async (req, res) => {
  try {
    const { userId } = req.body;
    await insertNotification({
      userId,
      senderId: null,
      type: "test",
      body: "This is a test notification 🔥",
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Voice room invite ────────────────────────────────────────────────────────
app.post("/voice-room-invite-notification", requireAppSecret, async (req, res) => {
  try {
    const { invitedUserId, hostId, roomId, roomTitle } = req.body || {};
    if (!invitedUserId || !hostId || !roomId) {
      return res.status(400).json({ error: "invitedUserId, hostId, and roomId are required" });
    }
    await insertNotification({
      userId: invitedUserId,
      senderId: hostId,
      type: "voice_room_invite",
      body: `invited you to ${roomTitle || "a voice room"}`,
      referenceId: roomId,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error("voice room invite notification error:", err);
    return res.status(500).json({ error: "Failed" });
  }
});

// ── Legacy message-notification (kept for backwards compat) ─────────────────
app.post("/message-notification", requireAppSecret, async (req, res) => {
  try {
    const { receiverId, senderId, conversationId, senderName } = req.body || {};
    if (!receiverId || !senderId || !conversationId) {
      return res.status(400).json({ error: "receiverId, senderId, and conversationId are required" });
    }
    await insertNotification({
      userId: receiverId,
      senderId,
      type: "message",
      body: `${senderName || "Someone"} sent you a message`,
      referenceId: conversationId,
    });
    return res.json({ success: true });
  } catch (err) {
    console.error("message notification error:", err);
    return res.status(500).json({ error: "Failed" });
  }
});

// ── OTP helpers ──────────────────────────────────────────────────────────────
async function sendOtpEmail({ to, subject, html }) {
  await apiInstance.sendTransacEmail({
    sender: { name: "TalkSwap", email: FROM_EMAIL.replace(/^.*<|>$/g, "") },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  });
}

// ── Send signup OTP ──────────────────────────────────────────────────────────
app.post("/send-otp", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "OTP database not configured" });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const saveOk = await dbPost("/email_otps", {
      email,
      otp,
      verified: false,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    if (!saveOk) return res.status(500).json({ error: "Failed to save OTP" });

    await sendOtpEmail({
      to: email,
      subject: "Your TalkSwap OTP",
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;color:#111;max-width:480px">
          <h2 style="margin:0 0 12px;color:#6F35FF">TalkSwap</h2>
          <p style="margin:0 0 16px;font-size:15px">Your one-time verification code:</p>
          <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#6F35FF;padding:16px 0">${otp}</div>
          <p style="margin-top:16px;color:#666;font-size:13px">This code expires in 5 minutes. Do not share it.</p>
        </div>
      `,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("send-otp error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Verify signup OTP ────────────────────────────────────────────────────────
app.post("/verify-otp", async (req, res) => {
  try {
    const email  = String(req.body?.email || "").trim().toLowerCase();
    const otp    = String(req.body?.otp   || "").trim();
    if (!email || !otp) return res.status(400).json({ error: "Email and OTP required" });

    const rows = await dbGet(
      `/email_otps?email=eq.${encodeURIComponent(email)}` +
      `&otp=eq.${encodeURIComponent(otp)}&verified=is.false&select=*`
    );

    if (!Array.isArray(rows) || !rows.length) {
      return res.json({ success: false, error: "Invalid OTP" });
    }

    const row = rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.json({ success: false, error: "OTP expired" });
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/email_otps?id=eq.${row.id}`, {
      method: "PATCH",
      headers: DB_HEADERS,
      body: JSON.stringify({ verified: true }),
    });
    if (!r.ok) return res.status(500).json({ error: "Failed to update OTP status" });

    return res.json({ success: true });
  } catch (err) {
    console.error("verify-otp error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Send password-reset OTP ──────────────────────────────────────────────────
app.post("/send-password-otp", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    await dbPost("/password_reset_otps", {
      email,
      otp,
      used: false,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    await sendOtpEmail({
      to: email,
      subject: "TalkSwap Password Reset",
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;color:#111;max-width:480px">
          <h2 style="margin:0 0 12px;color:#6F35FF">TalkSwap</h2>
          <p style="margin:0 0 16px;font-size:15px">Your password reset code:</p>
          <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#6F35FF;padding:16px 0">${otp}</div>
          <p style="margin-top:16px;color:#666;font-size:13px">This code expires in 5 minutes.</p>
        </div>
      `,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("send-password-otp error:", err);
    return res.status(500).json({ error: "Failed to send password OTP" });
  }
});

// ── Reset password with OTP ───────────────────────────────────────────────────
app.post("/reset-password-with-otp", async (req, res) => {
  try {
    const email       = String(req.body?.email       || "").trim().toLowerCase();
    const otp         = String(req.body?.otp         || "").trim();
    const newPassword = String(req.body?.newPassword || "").trim();

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: "Email, OTP and new password required" });
    }

    const rows = await dbGet(
      `/password_reset_otps?email=eq.${encodeURIComponent(email)}` +
      `&otp=eq.${encodeURIComponent(otp)}&used=is.false&select=*`
    );

    const row = rows?.[0];
    if (!row) return res.status(400).json({ error: "Invalid OTP" });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "OTP expired" });
    }

    const { data: listData, error: listError } = await supabaseAuthAdmin.auth.admin.listUsers();
    if (listError) throw listError;

    const user = listData.users.find(
      (u) => String(u.email || "").toLowerCase() === email
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const { error: updateError } = await supabaseAuthAdmin.auth.admin.updateUserById(
      user.id,
      { password: newPassword }
    );
    if (updateError) throw updateError;

    await fetch(`${SUPABASE_URL}/rest/v1/password_reset_otps?id=eq.${row.id}`, {
      method: "PATCH",
      headers: DB_HEADERS,
      body: JSON.stringify({ used: true }),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("reset-password-with-otp error:", err);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ TalkSwap backend running on port ${PORT}`);
});
