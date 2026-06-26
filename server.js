require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { AccessToken } = require("livekit-server-sdk");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { createClient } = require("@supabase/supabase-js");
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// LiveKit
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const TOKEN_ENDPOINT_SECRET = process.env.TOKEN_ENDPOINT_SECRET;

// OTP / email
const AWS_REGION = process.env.AWS_REGION || "ap-south-1";
const SES_FROM_EMAIL =
  process.env.SES_FROM_EMAIL || "TalkSwap <otp@talkswap.in>";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAuthAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const supabaseAdmin = {
  insertNotification: async ({
  userId,
  senderId,
  type,
  title = null,
  body,
  referenceId = null,
}) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
  user_id: userId,
  sender_id: senderId,
  type,
  title: title || null,
  body,
  reference_id: referenceId,
  is_read: false,
}),
      });

      if (!res.ok) {
        const text = await res.text();
        console.log("Notification insert error:", text);
      }
    } catch (err) {
      console.log("Notification error:", err.message);
    }
  },
};


const sesClient = new SESClient({
  region: AWS_REGION,
});

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("OTP routes need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
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

app.post("/notify", requireAppSecret, async (req, res) => {
  try {
    const {
      receiverId,
      senderId,
      type,
      title,
      body,
      referenceId = null,
      pushData = {},
    } = req.body || {};

    if (!receiverId || !type || !body) {
      return res.status(400).json({
        error: "receiverId, type, and body are required",
      });
    }

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${receiverId}&select=push_token,push_notifications,message_notifications,follow_notifications,voice_room_notifications,call_notifications,missed_call_notifications`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const profiles = await profileRes.json();
    const receiver = profiles?.[0];

    let allowed = receiver?.push_notifications !== false;

    if (type === "message" && receiver?.message_notifications === false) allowed = false;
    if ((type === "follow" || type === "follow_request" || type === "follow_back") && receiver?.follow_notifications === false) allowed = false;
    if (type === "voice_room_invite" && receiver?.voice_room_notifications === false) allowed = false;
    if (type === "incoming_call" && receiver?.call_notifications === false) allowed = false;
    if (type === "missed_call" && receiver?.missed_call_notifications === false) allowed = false;

    await supabaseAdmin.insertNotification({
      userId: receiverId,
      senderId: senderId || null,
      type,
      title: title || null,
      body,
      referenceId,
    });

    if (allowed && receiver?.push_token) {
      const pushResponse = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: receiver.push_token,
          sound: "default",
          title: title || "TalkSwap",
          body,
          data: {
            type,
            referenceId,
            senderId,
            ...pushData,
          },
          priority: "high",
          channelId: "default",
        }),
      });

      const pushResult = await pushResponse.json();

      return res.json({
        success: true,
        notification: true,
        push: pushResult,
      });
    }

    return res.json({
      success: true,
      notification: true,
      push: false,
    });
  } catch (error) {
    console.error("notify error:", error);
    return res.status(500).json({
      error: "Failed to notify user",
    });
  }
});
app.post("/test-notification", async (req, res) => {
  try {
    const { userId } = req.body;

    await supabaseAdmin.insertNotification({
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

app.post("/voice-room-invite-notification", requireAppSecret, async (req, res) => {
  try {
    const { invitedUserId, hostId, roomId, roomTitle } = req.body || {};

    if (!invitedUserId || !hostId || !roomId) {
      return res.status(400).json({
        error: "invitedUserId, hostId, and roomId are required",
      });
    }

    await supabaseAdmin.insertNotification({
      userId: invitedUserId,
      senderId: hostId,
      type: "voice_room_invite",
      body: `invited you to ${roomTitle || "a voice room"}`,
      referenceId: roomId,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("voice room invite notification error:", error);
    return res.status(500).json({
      error: "Failed to create voice room invite notification",
    });
  }
});


app.post("/message-notification", requireAppSecret, async (req, res) => {
  try {
    const { receiverId, senderId, conversationId, senderName } = req.body || {};

    if (!receiverId || !senderId || !conversationId) {
      return res.status(400).json({
        error: "receiverId, senderId, and conversationId are required",
      });
    }

    await supabaseAdmin.insertNotification({
      userId: receiverId,
      senderId,
      type: "message",
      body: `${senderName || "Someone"} sent you a message`,
      referenceId: conversationId,
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("message notification error:", error);
    return res.status(500).json({
      error: "Failed to create message notification",
    });
  }
});
async function sendOtpEmail({ to, subject, html }) {
  const command = new SendEmailCommand({
    Source: SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [to],
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: html,
          Charset: "UTF-8",
        },
      },
    },
  });

  return sesClient.send(command);
}
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    const safeEmail = String(email || "").trim().toLowerCase();

    if (!safeEmail) {
      return res.status(400).json({ error: "Email required" });
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

   const emailResult = await sendOtpEmail({
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
app.post("/send-password-otp", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    await fetch(`${SUPABASE_URL}/rest/v1/password_reset_otps`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        otp,
        used: false,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }),
    });

    await sendOtpEmail({
  to: email,
  subject: "TalkSwap Password Reset OTP",
  html: `
        <div style="font-family:Arial;padding:24px">
          <h2>TalkSwap Password Reset</h2>
          <p>Your OTP is:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px">${otp}</div>
          <p>This OTP expires in 5 minutes.</p>
        </div>
      `,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("send-password-otp error:", err);
    return res.status(500).json({
      error: "Failed to send password OTP",
    });
  }
});

app.post("/reset-password-with-otp", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const otp = String(req.body?.otp || "").trim();
    const newPassword = String(req.body?.newPassword || "").trim();

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        error: "Email, OTP and new password required",
      });
    }

    const otpRes = await fetch(
      `${SUPABASE_URL}/rest/v1/password_reset_otps?email=eq.${encodeURIComponent(email)}&otp=eq.${encodeURIComponent(otp)}&used=is.false&select=*`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    const rows = await otpRes.json();
    const otpRow = rows?.[0];

    if (!otpRow) {
      return res.status(400).json({
        error: "Invalid OTP",
      });
    }

    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        error: "OTP expired",
      });
    }

    const { data: listData, error: listError } =
      await supabaseAuthAdmin.auth.admin.listUsers();

    if (listError) throw listError;

    const user = listData.users.find(
      (u) => String(u.email || "").toLowerCase() === email
    );

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const { error: updateError } =
      await supabaseAuthAdmin.auth.admin.updateUserById(user.id, {
        password: newPassword,
      });

    if (updateError) throw updateError;

    await fetch(
      `${SUPABASE_URL}/rest/v1/password_reset_otps?id=eq.${otpRow.id}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          used: true,
        }),
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("reset-password-with-otp error:", err);

    return res.status(500).json({
      error: "Failed to reset password",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});
