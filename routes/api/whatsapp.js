const express = require("express");

const router = express.Router();
const WhatsAppConversation = require("../../models/WhatsAppConversation");
const WhatsAppMessage = require("../../models/WhatsAppMessage");
const PotentialCustomer = require("../../models/PotentialCustomer");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads, assignedScope } = require("../../services/leadsScope");
const { WA_CONV_STATUSES } = require("../../models/WhatsAppConversation");
const { sendWhatsAppText, sendWhatsAppMedia } = require("../../services/whatsappSend");
const { ensureAssignmentTask } = require("../../services/autoTask");

// WhatsApp inbox is restricted to owner/admin/team_leader. Regular members never
// see conversations directly — they receive a task (with the phone number) when a
// conversation is assigned to them.
const MANAGE = ["owner_admin", "admin", "team_leader"];

router.use(auth);
router.use(requireRole(...MANAGE));

// GET /whatsapp/conversations  (filters: status, assignedTo, search)
router.get("/conversations", async (req, res) => {
  try {
    const { status, assignedTo, search } = req.query;
    const query = { organization: req.user.organization };
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;

    const and = [];
    const scope = await assignedScope(req);
    if (scope) and.push(scope);
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      and.push({ $or: [{ customerName: rx }, { phoneNumber: rx }, { lastMessagePreview: rx }] });
    }
    if (and.length) query.$and = and;

    const items = await WhatsAppConversation.find(query)
      .populate("assignedTo", "name avatar")
      .populate("potentialCustomerId", "name status priority")
      .populate("customerId", "displayName")
      .sort({ lastMessageAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list whatsapp conversations error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Load one tenant + role-scoped conversation.
async function loadConv(req, res) {
  const conv = await WhatsAppConversation.findById(req.params.id)
    .populate("assignedTo", "name avatar")
    .populate("potentialCustomerId", "name companyName phone whatsapp email status priority source interestedService assignedTo")
    .populate("customerId", "displayName");
  if (!conv || String(conv.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Conversation not found" });
    return null;
  }
  if (!canSeeAllLeads(req)) {
    const scope = await assignedScope(req);
    const allowed = (scope.assignedTo.$in || []).map(String);
    if (!allowed.includes(String(conv.assignedTo?._id || conv.assignedTo))) {
      res.status(404).json({ message: "Conversation not found" });
      return null;
    }
  }
  return conv;
}

// GET /whatsapp/conversations/:id/messages  (internal sees notes too)
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const conv = await loadConv(req, res);
    if (!conv) return;
    const messages = await WhatsAppMessage.find({
      organization: req.user.organization,
      conversationId: conv._id,
    }).populate("sentBy", "name avatar").sort({ createdAt: 1 });
    // Opening a thread clears its unread badge.
    if (conv.unreadCount) { conv.unreadCount = 0; await conv.save(); }
    return res.json({ conversation: conv, messages });
  } catch (err) {
    console.error("whatsapp messages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /whatsapp/conversations/:id/messages  { messageText }  -> outbound reply
// NOTE: this stores the outbound message and updates the thread. Actual delivery
// through the WhatsApp Cloud API is a separate integration (not wired yet).
router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const conv = await loadConv(req, res);
    if (!conv) return;
    const b = req.body || {};
    const text = String(b.messageText || b.message || "").trim();
    const mediaType = ["audio", "image", "document", "video"].includes(b.messageType) ? b.messageType : null;
    const mediaUrl = b.mediaUrl ? String(b.mediaUrl) : "";
    if (!mediaType && !text) return res.status(400).json({ message: "Message is required" });
    if (mediaType && !mediaUrl) return res.status(400).json({ message: "mediaUrl is required" });

    // Try to deliver through the WhatsApp Cloud API; record the real outcome.
    const result = mediaType
      ? await sendWhatsAppMedia(conv.phoneNumber, mediaType, mediaUrl, text)
      : await sendWhatsAppText(conv.phoneNumber, text);
    const status = result.ok ? "sent" : result.skipped ? "queued" : "failed";

    const msg = await WhatsAppMessage.create({
      organization: req.user.organization,
      conversationId: conv._id,
      metaMessageId: result.messageId || "",
      phoneNumber: conv.phoneNumber,
      senderType: "internal",
      messageType: mediaType || "text",
      messageText: text,
      mediaUrl,
      status,
      sentBy: req.user.id,
    });
    const PREVIEW = { audio: "🎤 Voice message", image: "📷 Photo", document: "📎 Document", video: "🎬 Video" };
    conv.lastMessageAt = new Date();
    conv.lastMessagePreview = (text || PREVIEW[mediaType] || "").slice(0, 120);
    if (!conv.assignedTo) conv.assignedTo = req.user.id;
    if (conv.status === "open") conv.status = "pending";
    await conv.save();
    const out = await WhatsAppMessage.findById(msg._id).populate("sentBy", "name avatar");
    // Surface a delivery failure to the UI without losing the stored message.
    if (status === "failed") return res.status(201).json({ ...out.toObject(), deliveryError: result.error });
    return res.status(201).json(out);
  } catch (err) {
    console.error("whatsapp reply error:", err.message);
    return res.status(400).json({ message: err.message || "Could not send reply" });
  }
});

// POST /whatsapp/conversations/:id/internal-note  { messageText }
router.post("/conversations/:id/internal-note", async (req, res) => {
  try {
    const conv = await loadConv(req, res);
    if (!conv) return;
    const text = String(req.body?.messageText || req.body?.note || "").trim();
    if (!text) return res.status(400).json({ message: "Note is required" });
    const msg = await WhatsAppMessage.create({
      organization: req.user.organization,
      conversationId: conv._id,
      phoneNumber: conv.phoneNumber,
      senderType: "internal",
      messageType: "text",
      messageText: text,
      status: "sent",
      sentBy: req.user.id,
      isInternalNote: true,
    });
    const out = await WhatsAppMessage.findById(msg._id).populate("sentBy", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("whatsapp note error:", err.message);
    return res.status(400).json({ message: err.message || "Could not add note" });
  }
});

// PATCH /whatsapp/conversations/:id/assign  { assignedTo }
router.patch("/conversations/:id/assign", requireRole(...MANAGE), async (req, res) => {
  try {
    const conv = await loadConv(req, res);
    if (!conv) return;
    conv.assignedTo = req.body?.assignedTo || null;
    await conv.save();
    // Keep the linked lead's owner in sync when assigning the conversation.
    if (conv.potentialCustomerId?._id && conv.assignedTo) {
      await PotentialCustomer.findByIdAndUpdate(conv.potentialCustomerId._id, { assignedTo: conv.assignedTo });
    }
    // Give the assignee a task to action this conversation (they don't see the inbox).
    if (conv.assignedTo) {
      const pcDoc = conv.potentialCustomerId;
      const name = conv.customerName || pcDoc?.name || conv.phoneNumber;
      const lines = [`Reply to ${name} on WhatsApp.`, `Phone: ${conv.phoneNumber}`];
      if (pcDoc?.companyName) lines.push(`Company: ${pcDoc.companyName}`);
      if (pcDoc?.email) lines.push(`Email: ${pcDoc.email}`);
      if (pcDoc?.interestedService) lines.push(`Interested in: ${pcDoc.interestedService}`);
      await ensureAssignmentTask({
        organization: req.user.organization,
        assignedTo: conv.assignedTo,
        createdBy: req.user.id,
        type: "whatsapp_reply",
        title: `WhatsApp: ${name}`,
        contactName: name,
        contactPhone: conv.phoneNumber,
        relatedModule: "whatsapp_conversation",
        relatedRecordId: conv._id,
        relatedLabel: name,
        description: lines.join("\n"),
      });
    }
    const out = await WhatsAppConversation.findById(conv._id).populate("assignedTo", "name avatar");
    return res.json(out);
  } catch (err) {
    console.error("whatsapp assign error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /whatsapp/conversations/:id/status  { status }
router.patch("/conversations/:id/status", async (req, res) => {
  try {
    const status = req.body?.status;
    if (!WA_CONV_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
    const conv = await loadConv(req, res);
    if (!conv) return;
    conv.status = status;
    await conv.save();
    return res.json({ ok: true, _id: conv._id, status });
  } catch (err) {
    console.error("whatsapp status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
