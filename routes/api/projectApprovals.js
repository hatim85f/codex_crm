const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Project = require("../../models/Project");
const ProjectStep = require("../../models/ProjectStep");
const ProjectApproval = require("../../models/ProjectApproval");
const Customer = require("../../models/Customer");
const User = require("../../models/User");
const Organization = require("../../models/Organization");
const { auth, requireRole } = require("../../middleware/auth");
const { syncStepFromApproval } = require("../../services/approvalSync");
const { sendProjectApprovalRequest } = require("../../services/emailService");
const { requestWebBase } = require("../../services/publicWeb");
const { logActivity } = require("../../services/activityLog");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader", "developer", "designer", "content_creator", "accountant", "support"];
const TYPES = ProjectApproval.APPROVAL_TYPES;

router.use(auth);
router.use(requireRole(...INTERNAL));

const isAdmin = (req) => ["owner_admin", "admin"].includes(req.user.role);
const me = (req) => String(req.user.id);

async function loadProject(req, res, projectId) {
  const project = await Project.findOne({ _id: projectId, organization: req.user.organization, isDeleted: false });
  if (!project) { res.status(404).json({ message: "Project not found" }); return null; }
  return project;
}

async function canViewProject(req, project) {
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

const canManage = (req, project) => isAdmin(req) || String(project.projectLeaderId || "") === me(req);

function populate(query) {
  return query
    .populate("projectId", "projectName")
    .populate("projectStepId", "stepTitle status customerApprovalStatus requiresCustomerApproval")
    .populate("customerId", "displayName companyName")
    .populate("sentBy", "name email avatar")
    .populate("createdBy", "name email")
    .populate("respondedBy", "name email");
}

function sanitizeFiles(raw, req) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f) => f && f.fileUrl).map((f) => ({
    fileName: f.fileName || "", fileUrl: f.fileUrl, fileType: f.fileType || "", fileSize: Number(f.fileSize) || 0,
    uploadedAt: f.uploadedAt || new Date(), uploadedBy: f.uploadedBy || req.user.id,
  }));
}
function sanitizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const types = ProjectApproval.LINK_TYPES;
  return raw.filter((l) => l && l.url).map((l) => ({ label: l.label || "", url: l.url, type: types.includes(l.type) ? l.type : "other" }));
}

// GET /api/projects/:projectId/approvals
router.get("/projects/:projectId/approvals", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!(await canViewProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const items = await populate(ProjectApproval.find({ organization: req.user.organization, projectId: project._id, isDeleted: false })).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list approvals error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/project-approvals/by-customer/:customerId
router.get("/project-approvals/by-customer/:customerId", async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.customerId, organization: req.user.organization });
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const items = await populate(ProjectApproval.find({ organization: req.user.organization, customerId: customer._id, isDeleted: false })).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("approvals by customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/projects/:projectId/approvals
router.post("/projects/:projectId/approvals", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ message: "Approval title is required" });
    if (!b.projectStepId || !mongoose.Types.ObjectId.isValid(b.projectStepId)) return res.status(400).json({ message: "A linked project step is required" });
    const step = await ProjectStep.findOne({ _id: b.projectStepId, projectId: project._id, isDeleted: false });
    if (!step) return res.status(400).json({ message: "Step not found on this project" });

    const manager = canManage(req, project);
    const assignee = String(step.assignedTo || "") === me(req);
    if (!manager && !assignee) return res.status(403).json({ message: "You can only prepare approvals for projects you lead or steps assigned to you." });

    const approval = new ProjectApproval({
      organization: req.user.organization,
      projectId: project._id,
      projectStepId: step._id,
      customerId: project.customerId,
      title: String(b.title).trim(),
      message: b.message || "",
      approvalType: TYPES.includes(b.approvalType) ? b.approvalType : "general_approval",
      status: "draft",
      files: sanitizeFiles(b.files, req),
      links: sanitizeLinks(b.links),
      internalNotes: b.internalNotes || "",
      dueDate: b.dueDate || null,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    await approval.save();
    // Mark the linked step as needing approval.
    if (!step.requiresCustomerApproval) { step.requiresCustomerApproval = true; await step.save(); }
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("create approval error:", err.message);
    return res.status(400).json({ message: err.message || "Could not create approval" });
  }
});

async function loadApproval(req, res) {
  const approval = await ProjectApproval.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
  if (!approval) { res.status(404).json({ message: "Approval not found" }); return {}; }
  const project = await Project.findOne({ _id: approval.projectId, organization: req.user.organization });
  return { approval, project };
}

// GET /api/project-approvals/:id
router.get("/project-approvals/:id", async (req, res) => {
  try {
    const { approval, project } = await loadApproval(req, res);
    if (!approval) return;
    if (project && !(await canViewProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.json(out);
  } catch (err) {
    console.error("get approval error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/project-approvals/:id  (edit while draft or after a rejection)
router.put("/project-approvals/:id", async (req, res) => {
  try {
    const { approval, project } = await loadApproval(req, res);
    if (!approval) return;
    if (!canManage(req, project) && String(approval.createdBy || "") !== me(req)) return res.status(403).json({ message: "Not allowed" });
    if (!["draft", "rejected"].includes(approval.status)) return res.status(400).json({ message: "Only draft or returned approvals can be edited." });
    const b = req.body || {};
    if (b.title !== undefined) approval.title = String(b.title).trim();
    if (b.message !== undefined) approval.message = b.message;
    if (b.approvalType !== undefined && TYPES.includes(b.approvalType)) approval.approvalType = b.approvalType;
    if (b.files !== undefined) approval.files = sanitizeFiles(b.files, req);
    if (b.links !== undefined) approval.links = sanitizeLinks(b.links);
    if (b.internalNotes !== undefined) approval.internalNotes = b.internalNotes;
    if (b.dueDate !== undefined) approval.dueDate = b.dueDate || null;
    if (b.projectStepId !== undefined && mongoose.Types.ObjectId.isValid(b.projectStepId)) {
      const step = await ProjectStep.findOne({ _id: b.projectStepId, projectId: approval.projectId, isDeleted: false });
      if (step) approval.projectStepId = step._id;
    }
    approval.updatedBy = req.user.id;
    await approval.save();
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.json(out);
  } catch (err) {
    console.error("update approval error:", err.message);
    return res.status(400).json({ message: err.message || "Could not update approval" });
  }
});

// PATCH /api/project-approvals/:id/send
router.patch("/project-approvals/:id/send", async (req, res) => {
  try {
    const { approval, project } = await loadApproval(req, res);
    if (!approval) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can send approvals." });
    if (!["draft", "rejected", "sent_to_customer", "viewed"].includes(approval.status)) {
      return res.status(400).json({ message: "This approval can no longer be sent." });
    }
    approval.status = "sent_to_customer";
    approval.sentAt = new Date();
    approval.sentBy = req.user.id;
    approval.viewedAt = null;
    approval.approvedAt = null;
    approval.rejectedAt = null;
    approval.customerComment = "";
    approval.respondedBy = null;
    approval.updatedBy = req.user.id;
    await approval.save();
    await syncStepFromApproval(approval, "send");

    // Email the customer (best-effort).
    let emailError = null;
    try {
      const [customer, step, org, leaderProject] = await Promise.all([
        Customer.findById(approval.customerId).select("displayName companyName firstName lastName email"),
        ProjectStep.findById(approval.projectStepId).select("stepTitle"),
        Organization.findById(req.user.organization).select("name"),
        Project.findById(approval.projectId).populate("projectLeaderId", "name"),
      ]);
      const portalUsers = await User.find({ organization: req.user.organization, customerId: approval.customerId, userType: "customer", status: { $ne: "inactive" } }).select("name email");
      const candidates = [
        ...portalUsers.map((u) => ({ email: u.email, name: u.name })),
        { email: customer?.email, name: customer?.displayName },
      ];
      const unique = new Map();
      candidates.forEach((r) => { const a = String(r.email || "").trim().toLowerCase(); if (a && !unique.has(a)) unique.set(a, { email: a, name: r.name || a }); });
      const recipients = [...unique.values()];
      if (recipients.length) {
        const nameParts = String(recipients[0].name || "").trim().split(/\s+/);
        await sendProjectApprovalRequest({
          recipients,
          firstName: customer?.firstName || nameParts[0] || "",
          lastName: customer?.lastName || nameParts.slice(1).join(" "),
          customerName: customer?.displayName || customer?.companyName || "",
          projectName: leaderProject?.projectName || "",
          stepName: step?.stepTitle || "",
          approvalTitle: approval.title,
          approvalMessage: approval.message,
          approvalLink: `${requestWebBase(req)}/portal/approvals`,
          dueDate: approval.dueDate ? new Date(approval.dueDate).toISOString().slice(0, 10) : "—",
          teamLeader: leaderProject?.projectLeaderId?.name || "our team",
          companyName: org?.name || "Codex",
        });
      } else {
        emailError = "No customer email on file — the approval is visible in the portal but no email was sent.";
      }
    } catch (e) {
      emailError = e.message || "Email could not be sent, but the approval is live in the portal.";
    }

    logActivity({ organization: req.user.organization, customerId: approval.customerId, type: "project.approval.sent", message: `Approval "${approval.title}" sent to customer`, actorId: req.user.id });
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.json({ approval: out, emailError });
  } catch (err) {
    console.error("send approval error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/project-approvals/:id/cancel
router.patch("/project-approvals/:id/cancel", async (req, res) => {
  try {
    const { approval, project } = await loadApproval(req, res);
    if (!approval) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can cancel approvals." });
    if (["approved"].includes(approval.status)) return res.status(400).json({ message: "An approved item cannot be cancelled." });
    approval.status = "cancelled";
    approval.updatedBy = req.user.id;
    await approval.save();
    await syncStepFromApproval(approval, "cancel");
    const out = await populate(ProjectApproval.findById(approval._id));
    return res.json(out);
  } catch (err) {
    console.error("cancel approval error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/project-approvals/:id (soft delete)
router.delete("/project-approvals/:id", async (req, res) => {
  try {
    const { approval, project } = await loadApproval(req, res);
    if (!approval) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can delete approvals." });
    approval.isDeleted = true;
    approval.updatedBy = req.user.id;
    await approval.save();
    if (approval.status !== "approved") await syncStepFromApproval(approval, "cancel");
    return res.json({ ok: true, _id: approval._id });
  } catch (err) {
    console.error("delete approval error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
