const express = require("express");

const router = express.Router();
const WhatsAppConversation = require("../../models/WhatsAppConversation");
const WhatsAppMessage = require("../../models/WhatsAppMessage");
const PotentialCustomer = require("../../models/PotentialCustomer");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads, assignedScope } = require("../../services/leadsScope");
const { WA_CONV_STATUSES } = require("../../models/WhatsAppConversation");
const { sendWhatsAppText } = require("../../services/whatsappSend");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin", "team_leader"];

router.use(auth);
router.use(requireRole(...INTERNAL));

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
    const text = String(req.body?.messageText || req.body?.message || "").trim();
    if (!text) return res.status(400).json({ message: "Message is required" });

    // Try to deliver through the WhatsApp Cloud API; record the real outcome.
    const result = await sendWhatsAppText(conv.phoneNumber, text);
    const status = result.ok ? "sent" : result.skipped ? "queued" : "failed";

    const msg = await WhatsAppMessage.create({
      organization: req.user.organization,
      conversationId: conv._id,
      metaMessageId: result.messageId || "",
      phoneNumber: conv.phoneNumber,
      senderType: "internal",
      messageType: "text",
      messageText: text,
      status,
      sentBy: req.user.id,
    });
    conv.lastMessageAt = new Date();
    conv.lastMessagePreview = text.slice(0, 120);
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
