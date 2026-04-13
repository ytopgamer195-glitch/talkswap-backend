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
});