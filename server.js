// server.js

const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");
const Organization = require("./models/Organization"); // 🔹 adjust if needed

const app = express();

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json({ extended: false }));

// optional: stop favicon noise
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ====== CONNECT DATABASE ======
connectDB();

// ====== BASIC HEALTH CHECK ======
app.get("/", (__req, res) =>
  res.status(200).send("Codex CRM API is running..."),
);

// ====== MAIN ROUTES ======
app.use("/api/users", require("./routes/api/users"));
app.use("/api/auth", require("./routes/api/auth"));
app.use("/api/teams", require("./routes/api/team"));
app.use("/api/organization", require("./routes/api/organization"));
app.use("/api/edits", require("./routes/api/editings"));
app.use("/api/clients", require("./routes/api/clients"));
app.use("/api/whatsapp", require("./routes/api/whatsappWebhook"));

// ====== WHATSAPP WEBHOOK (GLOBAL, FOR ALL ORGS) ======
const createOrGetClientFromWhatsApp = require("./helpers/createOrGetClientFromWhatsApp");

const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || "codex-crm-whatsapp";

// ✅ 1) VERIFY WEBHOOK (Meta calls this with GET when you click "Verify and save")
app.get("/api/webhook/whatsapp", (req, res) => {
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

// ✅ 2) RECEIVE WHATSAPP MESSAGES (Meta sends POST for every update)
app.post("/api/webhook/whatsapp", async (req, res) => {
  try {
    console.log("✅ WA POST HIT", new Date().toISOString());
    console.log("BODY:", JSON.stringify(req.body));

    const body = req.body;
    console.dir(body, { depth: null });

    const entry = body.entry && body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;

    console.log("phone_number_id:", value?.metadata?.phone_number_id);
    console.log("from:", value?.messages?.[0]?.from);

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

    // 🔍 Multi-tenant: find org by phoneNumberId
    const org = await Organization.findOne({
      "leadIntegrations.whatsapp.phoneNumberId": phoneNumberId.toString(),
      "leadIntegrations.whatsapp.enabled": true,
    }).select("_id organizationName ownerId leadIntegrations");

    if (!org) {
      console.log("❌ No organization found for phoneNumberId:", phoneNumberId);
      return res.sendStatus(200);
    }

    console.log(
      `✅ Webhook belongs to org ${org._id.toString()} (${
        org.organizationName || "N/A"
      }) | ${displayPhoneNumber}`,
    );

    if (!value.messages || !value.messages.length) {
      return res.sendStatus(200);
    }

    const handledBy = org.ownerId || null;
    if (!handledBy) {
      console.log("⚠️ No ownerId on org, cannot assign client:", org._id);
      return res.sendStatus(200);
    }

    const countryCode =
      org.leadIntegrations?.whatsapp?.countryCode || "AE";

    const { client, isNew } = await createOrGetClientFromWhatsApp({
      orgId: org._id,
      handledBy,
      value,
      countryCode,
    });

    console.log(
      isNew
        ? `✅ New client created: ${client._id} (${client.firstName} ${client.lastName})`
        : `ℹ️ Existing client matched: ${client._id}`,
    );

    // Always 200 so Meta doesn't retry
    return res.sendStatus(200);
  } catch (error) {
    console.error("🔥 Error in WhatsApp webhook:", error);
    return res.sendStatus(500);
  }
});

// ====== 404 HANDLER (AFTER ALL ROUTES) ======
app.use((req, res, next) => {
  res.status(404).json({ message: "Route not found" });
});

// ====== ERROR HANDLER ======
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
});

// ====== START SERVER ======
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
