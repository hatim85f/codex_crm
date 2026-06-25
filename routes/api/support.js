const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const Customer = require("../../models/Customer");
const Project = require("../../models/Project");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const { auth, requireRole } = require("../../middleware/auth");
const { logActivity } = require("../../services/activityLog");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];

router.use(auth);
router.use(requireRole(...INTERNAL));

// Build a tenant + role scope for the conversations a user may see.
// admins see all; others see assigned-to-them, their customers, or their projects.
async function buildScope(req) {
  const org = req.user.organization;
  const base = { organization: org, isDeleted: false };
  if (["owner_admin", "admin"].includes(req.user.role)) return base;
  const me = req.user.id;
  const [custs, projs] = await Promise.all([
    Customer.find({ organization: org, $or: [{ assignedTo: me }, { assignees: me }] }).select("_id"),
    Project.find({ organization: org, projectLeaderId: me }).select("_id"),
  ]);
  return {
    ...base,
    $or: [
      { assignedTo: me },
      { customerId: { $in: custs.map((c) => c._id) } },
      { projectId: { $in: projs.map((p) => p._id) } },
    ],
  };
}

// GET /support/conversations
router.get("/conversations", async (req, res) => {
  try {
    const scope = await buildScope(req);
    const items = await SupportConversation.find(scope)
      .populate("customerId", "displayName companyName")
      .populate("projectId", "projectName")
      .populate("assignedTo", "name avatar")
      .sort({ lastMessageAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("support list error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadConversation(req, res) {
  const scope = await buildScope(req);
  const conv = await SupportConversation.findOne({ ...scope, _id: req.params.id });
  if (!conv) { res.status(404).json({ message: "Conversation not found" }); return null; }
  return conv;
}

// GET /support/conversations/:id/messages  (internal sees everything incl. notes)
router.get("/conversations/:id/messages", async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const items = await SupportMessage.find({ organization: req.user.organization, conversationId: conv._id, isDeleted: false })
      .populate("senderUserId", "name avatar")
      .populate("senderCustomerUserId", "name")
      .sort({ createdAt: 1 });
    return res.json({ conversation: conv, messages: items });
  } catch (err) {
    console.error("support messages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /support/conversations/:id/messages  { message, attachments?, isInternalNote? }
router.post("/conversations/:id/messages", async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const b = req.body || {};
    const text = String(b.message || "").trim();
    const attachments = Array.isArray(b.attachments) ? b.attachments : [];
    if (!text && !attachments.length) return res.status(400).json({ message: "Message is required" });
    const isInternalNote = !!b.isInternalNote;
    const msg = await SupportMessage.create({
      organization: req.user.organization,
      conversationId: conv._id,
      customerId: conv.customerId,
      projectId: conv.projectId,
      senderType: "internal",
      senderUserId: req.user.id,
      message: text,
      attachments,
      isInternalNote,
    });
    if (!isInternalNote) {
      conv.lastMessageAt = new Date();
      conv.lastMessagePreview = text.slice(0, 120) || "Attachment";
    }
    if (!conv.assignedTo) conv.assignedTo = req.user.id;
    if (conv.status === "open") conv.status = "in_progress";
    await conv.save();
    const out = await SupportMessage.findById(msg._id).populate("senderUserId", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("support reply error:", err.message);
    return res.status(400).json({ message: err.message || "Could not send reply" });
  }
});

// PATCH /support/conversations/:id/status  { status }
router.patch("/conversations/:id/status", async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const status = req.body?.status;
    if (!["open", "in_progress", "closed"].includes(status)) return res.status(400).json({ message: "Invalid status" });
    conv.status = status;
    await conv.save();
    return res.json({ ok: true, _id: conv._id, status });
  } catch (err) {
    console.error("support status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
