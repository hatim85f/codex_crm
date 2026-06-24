const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const ProjectApproval = require("../../models/ProjectApproval");
const { auth } = require("../../middleware/auth");
const { syncStepFromApproval } = require("../../services/approvalSync");
const { logActivity } = require("../../services/activityLog");

router.use(auth);

// Resolve the customer account on each request; block non-customers.
async function customerCtx(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.userType !== "customer" || !user.customerId) {
    res.status(403).json({ message: "Not a customer account" });
    return null;
  }
  return user;
}

// Visible to the customer: everything that has left draft and isn't cancelled.
const VISIBLE = ["sent_to_customer", "viewed", "approved", "rejected"];

function populate(query) {
  return query
    .select("-internalNotes")
    .populate("projectId", "projectName")
    .populate("projectStepId", "stepTitle")
    .populate("sentBy", "name");
}

// GET /api/customer-portal/approvals
router.get("/approvals", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const items = await populate(ProjectApproval.find({
      organization: user.organization, customerId: user.customerId, isDeleted: false, status: { $in: VISIBLE },
    })).sort({ sentAt: -1, createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("portal approvals error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadOwnApproval(req, res, user) {
  const approval = await ProjectApproval.findOne({
    _id: req.params.id, organization: user.organization, customerId: user.customerId, isDeleted: false, status: { $in: VISIBLE },
  });
  if (!approval) { res.status(404).json({ message: "Approval not found" }); return null; }
  return approval;
}

// GET /api/customer-portal/approvals/:id
router.get("/approvals/:id", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const exists = await loadOwnApproval(req, res, user);
    if (!exists) return;
    const out = await populate(ProjectApproval.findById(exists._id));
    return res.json(out);
  } catch (err) {
    console.error("portal approval error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/approvals/:id/viewed
router.patch("/approvals/:id/viewed", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const approval = await loadOwnApproval(req, res, user);
    if (!approval) return;
    if (approval.status === "sent_to_customer") {
      approval.status = "viewed";
      approval.viewedAt = new Date();
      await approval.save();
    }
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.json(out);
  } catch (err) {
    console.error("portal viewed error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/approvals/:id/approve
router.patch("/approvals/:id/approve", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const approval = await loadOwnApproval(req, res, user);
    if (!approval) return;
    if (!["sent_to_customer", "viewed"].includes(approval.status)) {
      return res.status(400).json({ message: "This item has already been reviewed." });
    }
    approval.status = "approved";
    approval.approvedAt = new Date();
    approval.customerComment = req.body?.customerComment || "";
    approval.respondedBy = user._id;
    await approval.save();
    await syncStepFromApproval(approval, "approve");
    logActivity({ organization: user.organization, customerId: user.customerId, type: "project.approval.approved", message: `${user.name} approved "${approval.title}"`, actorId: user._id, actorName: user.name });
    return res.json({ ok: true, _id: approval._id, status: approval.status });
  } catch (err) {
    console.error("portal approve error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/approvals/:id/reject  (comment required)
router.patch("/approvals/:id/reject", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const comment = String(req.body?.customerComment || "").trim();
    if (!comment) return res.status(400).json({ message: "Please add a comment describing the changes you'd like." });
    const approval = await loadOwnApproval(req, res, user);
    if (!approval) return;
    if (!["sent_to_customer", "viewed"].includes(approval.status)) {
      return res.status(400).json({ message: "This item has already been reviewed." });
    }
    approval.status = "rejected";
    approval.rejectedAt = new Date();
    approval.customerComment = comment;
    approval.respondedBy = user._id;
    await approval.save();
    await syncStepFromApproval(approval, "reject");
    logActivity({ organization: user.organization, customerId: user.customerId, type: "project.approval.rejected", message: `${user.name} requested changes on "${approval.title}"`, actorId: user._id, actorName: user.name });
    return res.json({ ok: true, _id: approval._id, status: approval.status });
  } catch (err) {
    console.error("portal reject error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
