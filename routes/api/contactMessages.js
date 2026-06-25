const express = require("express");

const router = express.Router();
const Customer = require("../../models/Customer");
const Project = require("../../models/Project");
const ContactMessage = require("../../models/ContactMessage");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];

router.use(auth);
router.use(requireRole(...INTERNAL));

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
      { assignedHandlerId: me },
      { customerId: { $in: custs.map((c) => c._id) } },
      { projectId: { $in: projs.map((p) => p._id) } },
    ],
  };
}

// GET /contact-messages
router.get("/", async (req, res) => {
  try {
    const scope = await buildScope(req);
    if (req.query.status) scope.status = req.query.status;
    const items = await ContactMessage.find(scope)
      .populate("customerId", "displayName companyName")
      .populate("projectId", "projectName")
      .populate("assignedHandlerId", "name avatar")
      .sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("contact list error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadMessage(req, res) {
  const scope = await buildScope(req);
  const msg = await ContactMessage.findOne({ ...scope, _id: req.params.id })
    .populate("customerId", "displayName companyName email phone")
    .populate("projectId", "projectName")
    .populate("assignedHandlerId", "name avatar email");
  if (!msg) { res.status(404).json({ message: "Message not found" }); return null; }
  return msg;
}

// GET /contact-messages/:id
router.get("/:id", async (req, res) => {
  try {
    const msg = await loadMessage(req, res);
    if (!msg) return;
    return res.json(msg);
  } catch (err) {
    console.error("contact get error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /contact-messages/:id/status  { status }
router.patch("/:id/status", async (req, res) => {
  try {
    const msg = await loadMessage(req, res);
    if (!msg) return;
    const status = req.body?.status;
    if (!["new", "in_review", "replied", "closed"].includes(status)) return res.status(400).json({ message: "Invalid status" });
    msg.status = status;
    await msg.save();
    return res.json({ ok: true, _id: msg._id, status });
  } catch (err) {
    console.error("contact status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /contact-messages/:id/assign  { assignedHandlerId }
router.patch("/:id/assign", async (req, res) => {
  try {
    const msg = await loadMessage(req, res);
    if (!msg) return;
    msg.assignedHandlerId = req.body?.assignedHandlerId || null;
    await msg.save();
    const out = await ContactMessage.findById(msg._id).populate("assignedHandlerId", "name avatar email");
    return res.json(out);
  } catch (err) {
    console.error("contact assign error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /contact-messages/:id/internal-note  { internalNotes }
router.patch("/:id/internal-note", async (req, res) => {
  try {
    const msg = await loadMessage(req, res);
    if (!msg) return;
    msg.internalNotes = String(req.body?.internalNotes || "");
    await msg.save();
    return res.json({ ok: true, _id: msg._id });
  } catch (err) {
    console.error("contact note error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
