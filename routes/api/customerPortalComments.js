const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const Project = require("../../models/Project");
const ProjectComment = require("../../models/ProjectComment");
const { auth } = require("../../middleware/auth");
const { logActivity } = require("../../services/activityLog");

router.use(auth);

async function customerCtx(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.userType !== "customer" || !user.customerId) {
    res.status(403).json({ message: "Not a customer account" });
    return null;
  }
  return user;
}

// Verify the project belongs to this customer.
async function ownProject(user, projectId) {
  return Project.findOne({ _id: projectId, organization: user.organization, customerId: user.customerId, isDeleted: false });
}

// GET /api/customer-portal/projects/:projectId/comments  (shared only)
router.get("/projects/:projectId/comments", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const project = await ownProject(user, req.params.projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    const items = await ProjectComment.find({
      organization: user.organization, projectId: project._id, isDeleted: false, visibility: "shared",
    }).populate("senderUserId", "name avatar").sort({ createdAt: 1 });
    return res.json(items);
  } catch (err) {
    console.error("portal comments error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/customer-portal/projects/:projectId/comments
router.post("/projects/:projectId/comments", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const project = await ownProject(user, req.params.projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });
    const b = req.body || {};
    if (!b.message || !String(b.message).trim()) return res.status(400).json({ message: "Message is required" });
    const comment = new ProjectComment({
      organization: user.organization,
      projectId: project._id,
      customerId: user.customerId,
      message: String(b.message).trim(),
      senderType: "customer",
      senderUserId: user._id,
      visibility: "shared", // customers can only post shared comments
    });
    await comment.save();
    logActivity({ organization: user.organization, customerId: user.customerId, type: "project.comment", message: "Customer added a project comment", actorId: user._id, actorName: user.name });
    const out = await ProjectComment.findById(comment._id).populate("senderUserId", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("portal add comment error:", err.message);
    return res.status(400).json({ message: err.message || "Could not add comment" });
  }
});

module.exports = router;
