const express = require("express");
const router = express.Router();
const Organization = require("../../models/Organization");
const auth = require("../../middleware/auth");

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

router.get("/:userId", auth, async (req, res) => {
  const { userId } = req.params;

  try {
    const organization = await Organization.findOne({ ownerId: userId });

    return res.status(200).send({ organization });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.put("/:orgId", auth, async (req, res) => {
  const { orgId } = req.params;
  const updateData = req.body;

  try {
    const updatedOrganization = await Organization.updateMany(
      orgId,
      updateData,
      { new: true }
    );

    if (!updatedOrganization) {
      return res.status(404).send({ message: "Organization not found" });
    }

    return res.status(200).send({ organization: updatedOrganization });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

// Update WhatsApp integration settings
// adding new route to save whatsapp webhook settings
router.put("/:orgId/whatsapp-webhook", auth, async (req, res) => {
  const { orgId } = req.params;

  const {
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    accessToken,
    webhookVerifyToken,
  } = req.body;

  try {
    if (!wabaId || !phoneNumberId || !accessToken) {
      return res
        .status(400)
        .json({ message: "Missing required WhatsApp fields" });
    }

    const org = await Organization.findOne({ _id: orgId });
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }

    // make sure social exists
    if (!org.social) {
      org.social = {};
    }

    // save whatsapp settings under org.social.whatsapp
    org.social.whatsapp = {
      wabaId: wabaId.toString(),
      phoneNumberId: phoneNumberId.toString(),
      displayPhoneNumber,
      accessToken,
      webhookVerifyToken,
      enabled: true,
      updatedAt: new Date(),
    };

    await org.save();

    return res.json({
      message: "WhatsApp settings saved successfully",
      whatsapp: org.social.whatsapp,
    });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

module.exports = router;
