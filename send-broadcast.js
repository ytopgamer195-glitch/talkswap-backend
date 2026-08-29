// send-broadcast.js
//
// Manual, one-off way to send a broadcast RIGHT NOW, no admin screen
// needed yet. Run from your backend project folder (same place
// broadcastService.js lives):
//
//   node send-broadcast.js "New friends are waiting!" "Hey {username}, meet new friends today! 🌍"
//
// {username} in the body gets replaced with each person's own username
// automatically — you don't need to do anything for that part.

require("dotenv").config();
const { sendBroadcast } = require("./broadcastService");

async function main() {
  const [, , title, body] = process.argv;

  if (!title || !body) {
    console.log('Usage: node send-broadcast.js "Title" "Body with {username}"');
    console.log(
      'Example: node send-broadcast.js "Come say hi!" "Hey {username}, new language partners just joined 🌍"'
    );
    process.exit(1);
  }

  console.log("Sending broadcast…");
  console.log("Title:", title);
  console.log("Body template:", body);

  try {
    const result = await sendBroadcast(title, body, null);
    console.log("\nDone.");
    console.log(`  Recipients:        ${result.totalRecipients}`);
    console.log(`  Delivered:         ${result.successCount}`);
    console.log(`  Failed:            ${result.failCount}`);
    console.log(`  Dead tokens cleared: ${result.deadTokensCleared}`);
    console.log(`  Campaign id:       ${result.campaignId}`);
  } catch (err) {
    console.error("Broadcast failed:", err.message);
    process.exit(1);
  }
}

main();
