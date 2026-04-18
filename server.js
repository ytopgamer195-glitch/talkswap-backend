<<<<<<< HEAD
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { AccessToken } = require("livekit-server-sdk");
const { Resend } = require("resend");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// LiveKit
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const TOKEN_ENDPOINT_SECRET = process.env.TOKEN_ENDPOINT_SECRET;

// OTP / email
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OTP_FROM_EMAIL = process.env.OTP_FROM_EMAIL || "TalkSwap <otp@talkswap.in>";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("OTP routes need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
}

if (!RESEND_API_KEY) {
  console.warn("OTP routes need RESEND_API_KEY");
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "talkswap-backend",
  });
});

function requireAppSecret(req, res, next) {
  if (!TOKEN_ENDPOINT_SECRET) return next();

  const headerSecret = req.headers["x-app-secret"];
  if (headerSecret !== TOKEN_ENDPOINT_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// -------------------------
// LIVEKIT TOKEN
// -------------------------
app.post("/token", requireAppSecret, async (req, res) => {
  try {
    const { roomName, userId, userName } = req.body || {};

    if (!roomName || !userId) {
      return res.status(400).json({
        error: "roomName and userId are required",
      });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(userId),
      name: String(userName || userId),
      ttl: "2h",
    });

    at.addGrant({
      roomJoin: true,
      room: String(roomName),
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return res.json({
      token,
      roomName: String(roomName),
      identity: String(userId),
    });
  } catch (error) {
    console.error("token error:", error);
    return res.status(500).json({
      error: "Failed to create token",
    });
  }
});

// -------------------------
// EXPO PUSH
// -------------------------
app.post("/send-push", requireAppSecret, async (req, res) => {
  try {
    const { token, title, body, data } = req.body || {};

    if (!token || !title || !body) {
      return res.status(400).json({
        error: "token, title, and body are required",
      });
    }

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title,
        body,
        data: data || {},
        priority: "high",
      }),
    });

    const result = await response.json();
    return res.status(response.ok ? 200 : 400).json(result);
  } catch (error) {
    console.error("push error:", error);
    return res.status(500).json({
      error: "Failed to send push notification",
    });
  }
});

// -------------------------
// SEND OTP
// -------------------------
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    const safeEmail = String(email || "").trim().toLowerCase();

    if (!safeEmail) {
      return res.status(400).json({ error: "Email required" });
    }

    if (!resend) {
      return res.status(500).json({ error: "Email service not configured" });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "OTP database not configured" });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const saveResponse = await fetch(`${SUPABASE_URL}/rest/v1/email_otps`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        email: safeEmail,
        otp,
        verified: false,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });

    if (!saveResponse.ok) {
      const text = await saveResponse.text();
      console.error("SAVE OTP ERROR:", text);
      return res.status(500).json({ error: "Failed to save OTP" });
    }

    const emailResult = await resend.emails.send({
      from: OTP_FROM_EMAIL,
      to: safeEmail,
      subject: "Your TalkSwap OTP",
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;color:#111">
          <h2 style="margin:0 0 12px">Your TalkSwap OTP</h2>
          <p style="margin:0 0 16px">Use this 4-digit code to continue:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px">${otp}</div>
          <p style="margin-top:16px;color:#666">This code expires in 5 minutes.</p>
        </div>
      `,
    });

    console.log("EMAIL RESULT:", emailResult);
    return res.json({ success: true });
  } catch (err) {
    console.error("SEND OTP ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------------
// VERIFY OTP
// -------------------------
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    const safeEmail = String(email || "").trim().toLowerCase();
    const safeOtp = String(otp || "").trim();

    if (!safeEmail || !safeOtp) {
      return res.status(400).json({ error: "Email and OTP required" });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "OTP database not configured" });
    }

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/email_otps?email=eq.${encodeURIComponent(
        safeEmail
      )}&otp=eq.${encodeURIComponent(safeOtp)}&verified=is.false&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("VERIFY FETCH ERROR:", text);
      return res.status(500).json({ error: "Verification query failed" });
    }

    const rows = await response.json();

    if (!Array.isArray(rows) || !rows.length) {
      return res.json({ success: false, error: "Invalid OTP" });
    }

    const otpRow = rows[0];

    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      return res.json({ success: false, error: "OTP expired" });
    }

    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/email_otps?id=eq.${otpRow.id}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          verified: true,
        }),
      }
    );

    if (!updateResponse.ok) {
      const text = await updateResponse.text();
      console.error("VERIFY UPDATE ERROR:", text);
      return res.status(500).json({ error: "Failed to update OTP status" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("VERIFY OTP ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
=======
// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

app.use(express.json());

app.use(
  cors({
    origin: "*",
  })
);

const PORT = process.env.PORT || 3000;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const TOKEN_ENDPOINT_SECRET = process.env.TOKEN_ENDPOINT_SECRET;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "talkswap-backend" });
});

function requireAppSecret(req, res, next) {
  if (!TOKEN_ENDPOINT_SECRET) return next();

  const headerSecret = req.headers["x-app-secret"];
  if (headerSecret !== TOKEN_ENDPOINT_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

app.post("/token", requireAppSecret, async (req, res) => {
  try {
    const { roomName, userId, userName } = req.body || {};

    if (!roomName || !userId) {
      return res.status(400).json({
        error: "roomName and userId are required",
      });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: String(userId),
      name: String(userName || userId),
      ttl: "2h",
    });

    at.addGrant({
      roomJoin: true,
      room: String(roomName),
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return res.json({
      token,
      roomName: String(roomName),
      identity: String(userId),
    });
  } catch (error) {
    console.error("token error:", error);
    return res.status(500).json({
      error: "Failed to create token",
    });
  }
});

app.post("/send-push", requireAppSecret, async (req, res) => {
  try {
    const { token, title, body, data } = req.body || {};

    if (!token || !title || !body) {
      return res.status(400).json({
        error: "token, title, and body are required",
      });
    }

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title,
        body,
        data: data || {},
        priority: "high",
      }),
    });

    const result = await response.json();

    return res.status(response.ok ? 200 : 400).json(result);
  } catch (error) {
    console.error("push error:", error);
    return res.status(500).json({
      error: "Failed to send push notification",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
>>>>>>> 245f86ceb58b4f9c4fa67e39416af8aad0829926
});