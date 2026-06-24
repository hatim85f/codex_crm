const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Project = require("../../models/Project");
const ProjectStep = require("../../models/ProjectStep");
const ProjectComment = require("../../models/ProjectComment");
const Customer = require("../../models/Customer");
const { auth, requireRole } = require("../../middleware/auth");
const { logActivity } = require("../../services/activityLog");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader", "developer", "designer", "content_creator", "accountant", "support"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const isAdmin = (req) => ["owner_admin", "admin"].includes(req.user.role);
const me = (req) => String(req.user.id);
const oid = (v) => (v && mongoose.Types.ObjectId.isValid(v) ? v : null);

async function loadProject(req, res, projectId) {
  const project = await Project.findOne({ _id: projectId, organization: req.user.organization, isDeleted: false });
  if (!project) { res.status(404).json({ message: "Project not found" }); return null; }
  return project;
}

async function canAccessProject(req, project) {
  if (isAdmin(req)) return true;
  const id = me(req);
  if (String(project.projectLeaderId || "") === id) return true;
  if ((project.assignedMembers || []).some((m) => String(m) === id)) return true;
  if (req.user.role === "sales") {
    const cust = await Customer.findOne({ _id: project.customerId, organization: req.user.organization, $or: [{ assignedTo: id }, { assignees: id }] }).select("_id").lean();
    if (cust) return true;
  }
  const stepForMe = await ProjectStep.findOne({ projectId: project._id, assignedTo: id, isDeleted: false }).select("_id").lean();
  return !!stepForMe;
}

const populate = (q) => q.populate("senderUserId", "name avatar role");

// GET /api/projects/:projectId/comments  (internal sees shared + internal_only)
router.get("/projects/:projectId/comments", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!(await canAccessProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const items = await populate(ProjectComment.find({ organization: req.user.organization, projectId: project._id, isDeleted: false })).sort({ createdAt: 1 });
    return res.json(items);
  } catch (err) {
    console.error("list comments error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/projects/:projectId/comments
router.post("/projects/:projectId/comments", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!(await canAccessProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const b = req.body || {};
    if (!b.message || !String(b.message).trim()) return res.status(400).json({ message: "Message is required" });
    const comment = new ProjectComment({
      organization: req.user.organization,
      projectId: project._id,
      customerId: project.customerId,
      projectStepId: oid(b.projectStepId),
      approvalId: oid(b.approvalId),
      deliveryId: oid(b.deliveryId),
      parentCommentId: oid(b.parentCommentId),
      message: String(b.message).trim(),
      senderType: "internal",
      senderUserId: req.user.id,
      visibility: b.visibility === "internal_only" ? "internal_only" : "shared",
      attachments: Array.isArray(b.attachments) ? b.attachments.filter((a) => a && a.fileUrl) : [],
    });
    await comment.save();
    logActivity({ organization: req.user.organization, customerId: project.customerId, type: "project.comment", message: "Team added a project comment", actorId: req.user.id });
    const out = await populate(ProjectComment.findById(comment._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("create comment error:", err.message);
    return res.status(400).json({ message: err.message || "Could not add comment" });
  }
});

// POST /api/project-comments/:id/reply
router.post("/project-comments/:id/reply", async (req, res) => {
  try {
    const parent = await ProjectComment.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
    if (!parent) return res.status(404).json({ message: "Comment not found" });
    const project = await Project.findOne({ _id: parent.projectId, organization: req.user.organization, isDeleted: false });
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (!(await canAccessProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const b = req.body || {};
    if (!b.message || !String(b.message).trim()) return res.status(400).json({ message: "Message is required" });
    const comment = new ProjectComment({
      organization: req.user.organization,
      projectId: parent.projectId,
      customerId: parent.customerId,
      parentCommentId: parent._id,
      message: String(b.message).trim(),
      senderType: "internal",
      senderUserId: req.user.id,
      visibility: b.visibility === "internal_only" ? "internal_only" : "shared",
    });
    await comment.save();
    const out = await populate(ProjectComment.findById(comment._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("reply comment error:", err.message);
    return res.status(400).json({ message: err.message || "Could not reply" });
  }
});

// PUT /api/project-comments/:id  (author or admin)
router.put("/project-comments/:id", async (req, res) => {
  try {
    const comment = await ProjectComment.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
    if (!comment) return res.status(404).json({ message: "Comment not found" });
    if (!isAdmin(req) && String(comment.senderUserId || "") !== me(req)) return res.status(403).json({ message: "You can only edit your own comments." });
    const b = req.body || {};
    if (b.message !== undefined) comment.message = String(b.message).trim();
    if (b.visibility !== undefined && comment.senderType === "internal") comment.visibility = b.visibility === "internal_only" ? "internal_only" : "shared";
    await comment.save();
    const out = await populate(ProjectComment.findById(comment._id));
    return res.json(out);
  } catch (err) {
    console.error("edit comment error:", err.message);
    return res.status(400).json({ message: err.message || "Could not edit comment" });
  }
});

// DELETE /api/project-comments/:id (soft delete — author or admin)
router.delete("/project-comments/:id", async (req, res) => {
  try {
    const comment = await ProjectComment.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
    if (!comment) return res.status(404).json({ message: "Comment not found" });
    if (!isAdmin(req) && String(comment.senderUserId || "") !== me(req)) return res.status(403).json({ message: "You can only delete your own comments." });
    comment.isDeleted = true;
    await comment.save();
    return res.json({ ok: true, _id: comment._id });
  } catch (err) {
    console.error("delete comment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
