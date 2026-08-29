// admin-broadcast-route.js
//
// NOT a standalone server — this is a snippet to paste into your existing
// backend (the same Express app that already has /send-otp, /verify-otp,
// etc.). It doesn't duplicate any logic; it just calls the same
// sendBroadcast() function the CLI script uses.
//
// ─────────────────────────────────────────────────────────────────────────
// HOW TO WIRE THIS IN
// ─────────────────────────────────────────────────────────────────────────
// 1. Make sure broadcastService.js sits next to your server file (or
//    adjust the require path below to wherever you put it).
// 2. Add ADMIN_BROADCAST_SECRET to your backend's environment variables —
//    a long random string, e.g. generate one with:
//      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// 3. Paste the block below into your server file (wherever the other
//    app.post(...) routes are defined), after `const app = express();`
//    and after `app.use(express.json());` (or equivalent body parser).
// 4. This does NOT check Supabase auth / who's logged into the app — it
//    only checks the shared secret header. That's fine for "only I can
//    trigger this via a script/Postman for now," but before wiring a real
//    admin SCREEN in the app to this route, swap this out for a proper
//    check that the calling user has an `is_admin` flag on their profile
//    (verify their Supabase JWT server-side, then look up that flag) —
//    a shared secret baked into the app bundle can be extracted by anyone
//    who decompiles the app, which is fine for a script you run yourself
//    but not for something the shipped app calls.
// ─────────────────────────────────────────────────────────────────────────

const { sendBroadcast } = require("./broadcastService");

function registerBroadcastRoute(app) {
  app.post("/admin/broadcast", async (req, res) => {
    const providedSecret = req.headers["x-admin-secret"];

    if (!process.env.ADMIN_BROADCAST_SECRET) {
      return res.status(500).json({ error: "ADMIN_BROADCAST_SECRET is not configured on the server." });
    }

    if (providedSecret !== process.env.ADMIN_BROADCAST_SECRET) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { title, body, sentBy } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are both required" });
    }

    try {
      const result = await sendBroadcast(title, body, sentBy || null);
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Broadcast failed" });
    }
  });
}

module.exports = { registerBroadcastRoute };

// ─────────────────────────────────────────────────────────────────────────
// Example of wiring it into your existing server.js / index.js:
//
//   const express = require("express");
//   const { registerBroadcastRoute } = require("./admin-broadcast-route");
//
//   const app = express();
//   app.use(express.json());
//   registerBroadcastRoute(app);
//
//   // ... your existing /send-otp, /verify-otp routes ...
//
//   app.listen(process.env.PORT || 3000);
//
// Example call once it's deployed (e.g. from Postman, curl, or later the
// admin screen):
//
//   curl -X POST https://talkswap-backend.onrender.com/admin/broadcast \
//     -H "Content-Type: application/json" \
//     -H "x-admin-secret: <your ADMIN_BROADCAST_SECRET>" \
//     -d '{"title":"New friends are waiting!","body":"Hey {username}, meet new friends today! 🌍"}'
// ─────────────────────────────────────────────────────────────────────────
