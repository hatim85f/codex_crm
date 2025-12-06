const express = require("express");
const router = express.Router();
const Organization = require("./models/Organization");
const connectDB = require("./config/db");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ extended: false }));

// optional: stop favicon noise
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Connect Database
connectDB();

app.get("/", (__req, res) =>
  res.status(200).send("Codex CRM API is running...")
);

app.use("/api/users", require("./routes/api/users"));
app.use("/api/auth", require("./routes/api/auth"));
app.use("/api/teams", require("./routes/api/team"));
app.use("/api/organization", require("./routes/api/organization"));
app.use("/api/edits", require("./routes/api/editings"));

// error handler (so unhandled errors don’t crash silently)
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
});

const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || "codex-crm-whatsapp";

router.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

// ✅ Incoming messages endpoint (POST) - Meta sends messages/updates here
router.post("/webhook/whatsapp", async (req, res) => {
  try {
    const body = req.body;
    console.dir(body, { depth: null });

    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;

    if (!value || !value.metadata) {
      console.log("⚠️ No value/metadata in webhook payload");
      return res.sendStatus(200);
    }

    const phoneNumberId = value.metadata.phone_number_id;
    const displayPhoneNumber = value.metadata.display_phone_number;

    if (!phoneNumberId) {
      console.log("⚠️ No phone_number_id in webhook payload");
      return res.sendStatus(200);
    }

    // 🔍 Find org by phoneNumberId (multi-tenant logic)
    const org = await Organization.findOne({
      "social.whatsapp.phoneNumberId": phoneNumberId.toString(),
      "social.whatsapp.enabled": true,
    });

    if (!org) {
      console.log("❌ No organization found for phoneNumberId:", phoneNumberId);
      return res.sendStatus(200);
    }

    console.log(
      `✅ Webhook belongs to org ${org._id.toString()} (${
        org.organizationName || "N/A"
      }) | ${displayPhoneNumber}`
    );

    // 📩 Handle incoming messages (if any)
    const messages = value.messages || [];

    for (const msg of messages) {
      const from = msg.from; // customer phone
      const msgId = msg.id;
      const timestamp = msg.timestamp;
      const type = msg.type;
      const text = msg.text && msg.text.body;

      console.log("📩 Incoming message:", {
        orgId: org._id.toString(),
        from,
        msgId,
        type,
        text,
        timestamp,
      });

      // TODO:
      // - Save to Message collection with orgId
      // - Link to Conversation per customer
      // - Emit socket / push notification to admins
    }

    // Always respond 200 so Meta doesn't retry
    return res.sendStatus(200);
  } catch (error) {
    console.error("🔥 Error in WhatsApp webhook:", error);
    return res.sendStatus(500);
  }
});

// not found
app.use((req, res, next) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
