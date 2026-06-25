const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const MetaIntegrationLog = require("../../models/MetaIntegrationLog");
const MetaLeadReport = require("../../models/MetaLeadReport");
const WhatsAppConversation = require("../../models/WhatsAppConversation");
const WhatsAppMessage = require("../../models/WhatsAppMessage");
const PotentialCustomer = require("../../models/PotentialCustomer");
const Organization = require("../../models/Organization");
const User = require("../../models/User");
const { fetchAndStoreMedia } = require("../../services/whatsappMedia");

// This router is mounted BEFORE express.json() in server.js so we get the raw
// request body — Meta signs the raw bytes (X-Hub-Signature-256), same as Stripe.
router.use(express.raw({ type: "*/*" }));

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || "";
const APP_SECRET = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || "";

// GET /api/meta/webhook -> verification handshake (Meta calls this once when you
// save the callback URL). Echo hub.challenge only if the verify token matches.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Verify the payload signature against the app secret.
function verifySignature(req) {
  if (!APP_SECRET) return true; // not enforced until the secret is configured
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// Which tenant do inbound events belong to? This deployment is single-tenant
// (Codex FZE's own CRM), so we resolve a default org. For white-label/multi-tenant
// later, map the WhatsApp phone_number_id / Meta page_id to an Organization here.
let cachedOrgId = null;
async function resolveOrganization() {
  if (process.env.META_DEFAULT_ORG) return process.env.META_DEFAULT_ORG;
  if (cachedOrgId) return cachedOrgId;
  // Prefer the tenant that owns the workspace (the org of an owner_admin), so events
  // never land on a stray/empty Organization. Fall back to any org if none found.
  const owner = await User.findOne({ role: "owner_admin", userType: "internal" })
    .select("organization").sort({ createdAt: 1 });
  if (owner?.organization) { cachedOrgId = owner.organization; return cachedOrgId; }
  const org = await Organization.findOne().select("_id").sort({ createdAt: 1 });
  cachedOrgId = org?._id || null;
  return cachedOrgId;
}

// ---- WhatsApp inbound: create/update conversation + message, auto-create lead ----
async function processWhatsAppValue(organization, value) {
  const contacts = value.contacts || [];
  const messages = value.messages || [];
  const profileName = contacts[0]?.profile?.name || "";

  for (const m of messages) {
    const phone = m.from || contacts[0]?.wa_id || "";
    if (!phone) continue;

    // Idempotency: skip a message we've already stored.
    if (m.id) {
      const dupe = await WhatsAppMessage.findOne({ organization, metaMessageId: m.id });
      if (dupe) continue;
    }

    let conv = await WhatsAppConversation.findOne({ organization, phoneNumber: phone });
    if (!conv) {
      // Unknown number -> spin up a conversation AND a potential customer.
      const lead = await PotentialCustomer.create({
        organization,
        name: profileName || phone,
        whatsapp: phone,
        phone,
        source: "whatsapp",
        status: "new_inquiry",
        priority: "medium",
        firstMessage: m.text?.body || "",
        lastMessageAt: new Date(),
      });
      conv = await WhatsAppConversation.create({
        organization,
        phoneNumber: phone,
        customerName: profileName || "",
        potentialCustomerId: lead._id,
        status: "open",
      });
    } else if (profileName && !conv.customerName) {
      conv.customerName = profileName;
    }

    const type = ["text", "image", "document", "audio", "video"].includes(m.type) ? m.type : "unknown";
    const text = m.text?.body || m[type]?.caption || "";
    // Re-host any media (voice note / image / file) so it's actually playable.
    const mediaId = m[type]?.id || "";
    const mediaUrl = mediaId ? await fetchAndStoreMedia(mediaId) : "";
    await WhatsAppMessage.create({
      organization,
      conversationId: conv._id,
      metaMessageId: m.id || "",
      phoneNumber: phone,
      senderType: "customer",
      messageType: type,
      messageText: text,
      mediaUrl,
      rawPayload: m,
      status: "received",
    });

    const PREVIEW = { audio: "🎤 Voice message", image: "📷 Photo", document: "📎 Document", video: "🎬 Video" };
    conv.lastMessageAt = new Date();
    conv.lastMessagePreview = (text || PREVIEW[type] || `[${type}]`).slice(0, 120);
    conv.unreadCount = (conv.unreadCount || 0) + 1;
    if (conv.status === "resolved" || conv.status === "archived") conv.status = "open";
    await conv.save();
  }
}

// ---- Lead Ads: save to MetaLeadReport ONLY (never auto-create a customer) ----
async function processLeadgen(organization, change) {
  const v = change.value || {};
  const metaLeadId = v.leadgen_id || v.lead_id || "";
  if (metaLeadId) {
    const exists = await MetaLeadReport.findOne({ organization, metaLeadId });
    if (exists) return; // already captured
  }
  // field_data may arrive inline; otherwise it needs a Graph API fetch (not wired).
  const fieldData = (v.field_data || []).map((f) => ({
    name: f.name || "",
    label: f.name || "",
    value: Array.isArray(f.values) ? f.values.join(", ") : String(f.values ?? ""),
  }));
  const pick = (...names) => {
    const f = fieldData.find((x) => names.includes((x.name || "").toLowerCase()));
    return f?.value || "";
  };
  const phone = pick("phone_number", "phone");
  const email = pick("email");

  // Duplicate detection on phone/email within the tenant.
  let isDuplicate = false;
  let duplicateOf = null;
  if (phone || email) {
    const dupe = await MetaLeadReport.findOne({
      organization,
      $or: [phone ? { phone } : null, email ? { email } : null].filter(Boolean),
    }).sort({ createdAt: 1 });
    if (dupe) { isDuplicate = true; duplicateOf = dupe._id; }
  }

  await MetaLeadReport.create({
    organization,
    metaLeadId,
    pageId: v.page_id || "",
    formId: v.form_id || "",
    adId: v.ad_id || "",
    adName: v.ad_name || "",
    campaignId: v.campaign_id || "",
    campaignName: v.campaign_name || "",
    submittedAt: v.created_time ? new Date(Number(v.created_time) * 1000) : new Date(),
    fullName: pick("full_name", "name") || "",
    phone,
    email,
    fieldData,
    status: isDuplicate ? "duplicate" : "new",
    isDuplicate,
    duplicateOf,
    rawPayload: v,
  });
}

// POST /api/meta/webhook -> receive WhatsApp + Lead Ads events.
// Always 200 fast so Meta doesn't retry/disable the hook; process afterwards.
router.post("/webhook", (req, res) => {
  res.sendStatus(200);
  if (!verifySignature(req)) {
    console.warn("Meta webhook: signature mismatch — ignoring payload");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
  } catch (e) {
    console.warn("Meta webhook: could not parse body");
    return;
  }
  // Persist + process out of band; never block the 200 response.
  handleEvent(payload).catch((e) => console.error("Meta webhook processing error:", e.message));
});

async function handleEvent(payload) {
  const organization = await resolveOrganization();
  const isWhatsApp = payload.object === "whatsapp_business_account";
  const source = isWhatsApp ? "whatsapp" : "lead_ads";

  // 1) Always log the raw event BEFORE processing.
  const log = await MetaIntegrationLog.create({
    organization,
    eventType: isWhatsApp ? "whatsapp.message" : "leadgen",
    source,
    metaObjectId: payload.entry?.[0]?.id || "",
    status: "received",
    rawPayload: payload,
  });

  try {
    if (!organization) throw new Error("No organization resolved for inbound Meta event");
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (isWhatsApp && change.field === "messages") {
          await processWhatsAppValue(organization, change.value || {});
        } else if (!isWhatsApp && change.field === "leadgen") {
          await processLeadgen(organization, change);
        }
      }
    }
    log.status = "processed";
    log.processedAt = new Date();
    await log.save();
  } catch (e) {
    log.status = "error";
    log.errorMessage = e.message;
    log.processedAt = new Date();
    await log.save();
    throw e;
  }
}

module.exports = router;
