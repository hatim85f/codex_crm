const express = require("express");
const router = express.Router();

const Organization = require("../../models/Organization"); // <-- adjust path/name if different
const createOrGetClientFromWhatsApp = require("../../helpers/createOrGetClientFromWhatsApp");

// ✅ 1) Verification (Meta calls this once when you set webhook)
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // set this in your .env
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ✅ 2) Incoming messages (Meta sends POST events here)
router.post("/", async (req, res) => {
  try {
    const body = req.body;

    // Always ACK quickly
    res.sendStatus(200);

    if (!body?.entry?.length) return;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change?.value;
        if (!value) continue;

        // If not a message event, skip
        if (!value.messages || !value.messages.length) continue;

        // Multi-tenant routing: which org owns this WhatsApp number?
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // You must store this mapping when you connect WhatsApp to org
        // Example in org doc: org.whatsapp.phoneNumberId
        const org = await Organization.findOne({
          "whatsapp.phoneNumberId": phoneNumberId,
        }).select("_id ownerId assignedDefaultUserId");

        if (!org) {
          console.log(
            "No organization matched phone_number_id:",
            phoneNumberId
          );
          continue;
        }

        // Decide who will "handle" this lead initially
        const handledBy = org.assignedDefaultUserId || org.ownerId || null;

        if (!handledBy) {
          console.log("No handledBy found for org:", org._id);
          continue;
        }

        // ✅ Create client (or get existing)
        await createOrGetClientFromWhatsApp({
          orgId: org._id,
          handledBy,
          value, // changes[0].value
          countryCode: "AE", // or infer by org settings later
        });

        // Conversation saving later (as you said)
      }
    }
  } catch (err) {
    console.log("WhatsApp webhook error:", err.message);
    // We already responded 200; just log.
  }
});

module.exports = router;
