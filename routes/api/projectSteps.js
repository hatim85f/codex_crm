const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Project = require("../../models/Project");
const ProjectStep = require("../../models/ProjectStep");
const Customer = require("../../models/Customer");
const { auth, requireRole } = require("../../middleware/auth");
const { recalcProjectProgress, computeFromSteps } = require("../../services/projectProgress");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader", "developer", "designer", "content_creator", "accountant", "support"];
const STATUSES = ProjectStep.STEP_STATUSES;

router.use(auth);
router.use(requireRole(...INTERNAL));

const isAdmin = (req) => ["owner_admin", "admin"].includes(req.user.role);
const me = (req) => String(req.user.id);
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

// Hardcoded default website project steps (Phase 2 — template collection deferred).
const DEFAULT_STEPS = [
  { stepTitle: "Collecting data from client", weight: 10 },
  { stepTitle: "UI/UX Design", weight: 20 },
  { stepTitle: "Design approval preparation", weight: 10 },
  { stepTitle: "Backend Development", weight: 25 },
  { stepTitle: "Frontend Development", weight: 25 },
  { stepTitle: "Testing and Delivery", weight: 10 },
];

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
  // A member assigned to any step of this project can also view.
  const stepForMe = await ProjectStep.findOne({ projectId: project._id, assignedTo: id, isDeleted: false }).select("_id").lean();
  return !!stepForMe;
}

// Manage = create/edit/delete/reorder/review/weights (admin or this project's leader).
function canManageSteps(req, project) {
  return isAdmin(req) || String(project.projectLeaderId || "") === me(req);
}

function populateStep(query) {
  return query
    .populate("assignedTo", "name email avatar role")
    .populate("submittedBy", "name email avatar")
    .populate("reviewedBy", "name email avatar");
}

function sanitizeStepBody(body, { allowWeightOrder = true } = {}) {
  const out = {};
  if (body.stepTitle !== undefined) out.stepTitle = String(body.stepTitle).trim();
  if (body.description !== undefined) out.description = body.description || "";
  if (body.assignedTo !== undefined) out.assignedTo = body.assignedTo && mongoose.Types.ObjectId.isValid(body.assignedTo) ? body.assignedTo : null;
  if (body.dueDate !== undefined) out.dueDate = body.dueDate || null;
  if (body.status !== undefined && STATUSES.includes(body.status)) out.status = body.status;
  if (body.progress !== undefined) out.progress = clamp(body.progress);
  if (body.requiresCustomerApproval !== undefined) {
    out.requiresCustomerApproval = !!body.requiresCustomerApproval;
    out.customerApprovalStatus = body.requiresCustomerApproval ? "pending" : "not_required";
  }
  if (body.notes !== undefined) out.notes = body.notes || "";
  if (allowWeightOrder) {
    if (body.weight !== undefined) out.weight = Math.max(0, Number(body.weight) || 0);
    if (body.order !== undefined) out.order = Number(body.order) || 0;
  }
  return out;
}

/* ----------- list / create under a project ----------- */

// GET /api/projects/:projectId/steps
router.get("/projects/:projectId/steps", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!(await canViewProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const steps = await populateStep(ProjectStep.find({ projectId: project._id, isDeleted: false })).sort({ order: 1, createdAt: 1 });
    const summary = computeFromSteps(steps);
    return res.json({ steps, summary });
  } catch (err) {
    console.error("list steps error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/projects/:projectId/steps
router.post("/projects/:projectId/steps", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!canManageSteps(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can add steps." });
    const b = req.body || {};
    if (!b.stepTitle) return res.status(400).json({ message: "Step title is required" });
    const last = await ProjectStep.findOne({ projectId: project._id, isDeleted: false }).sort({ order: -1 }).select("order").lean();
    const step = new ProjectStep({
      organization: req.user.organization,
      projectId: project._id,
      order: b.order !== undefined ? Number(b.order) || 0 : (last ? last.order + 1 : 0),
      ...sanitizeStepBody(b),
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("create step error:", err.message);
    return res.status(400).json({ message: err.message || "Could not create step" });
  }
});

// POST /api/projects/:projectId/steps/default  -> add the default website steps
router.post("/projects/:projectId/steps/default", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!canManageSteps(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can add steps." });
    const last = await ProjectStep.findOne({ projectId: project._id, isDeleted: false }).sort({ order: -1 }).select("order").lean();
    let order = last ? last.order + 1 : 0;
    const docs = DEFAULT_STEPS.map((s) => ({
      organization: req.user.organization,
      projectId: project._id,
      stepTitle: s.stepTitle,
      weight: s.weight,
      order: order++,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    }));
    await ProjectStep.insertMany(docs);
    await recalcProjectProgress(project._id);
    const steps = await populateStep(ProjectStep.find({ projectId: project._id, isDeleted: false })).sort({ order: 1, createdAt: 1 });
    return res.status(201).json({ steps, summary: computeFromSteps(steps) });
  } catch (err) {
    console.error("default steps error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ----------- my tasks ----------- */

// GET /api/my-project-steps  (steps assigned to the logged-in user)
router.get("/my-project-steps", async (req, res) => {
  try {
    const { search, status } = req.query;
    const query = { organization: req.user.organization, assignedTo: req.user.id, isDeleted: false };
    if (status) query.status = status;
    if (search) query.stepTitle = new RegExp(String(search).trim(), "i");
    const steps = await populateStep(ProjectStep.find(query))
      .populate({ path: "projectId", select: "projectName customerId status", populate: { path: "customerId", select: "displayName companyName" } })
      .sort({ dueDate: 1, createdAt: -1 });
    return res.json(steps);
  } catch (err) {
    console.error("my project steps error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ----------- single step operations ----------- */

async function loadStep(req, res) {
  const step = await ProjectStep.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
  if (!step) { res.status(404).json({ message: "Step not found" }); return {}; }
  const project = await Project.findOne({ _id: step.projectId, organization: req.user.organization, isDeleted: false });
  if (!project) { res.status(404).json({ message: "Project not found" }); return {}; }
  return { step, project };
}

const isAssignee = (req, step) => String(step.assignedTo || "") === me(req);

// GET /api/project-steps/:id
router.get("/project-steps/:id", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!(await canViewProject(req, project)) && !isAssignee(req, step)) return res.status(403).json({ message: "Not allowed" });
    const out = await populateStep(ProjectStep.findById(step._id))
      .populate({ path: "projectId", select: "projectName customerId", populate: { path: "customerId", select: "displayName companyName" } });
    return res.json(out);
  } catch (err) {
    console.error("get step error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/project-steps/:id  (full edit — managers; assignee limited to progress/notes/status)
router.put("/project-steps/:id", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    const manage = canManageSteps(req, project);
    if (!manage && !isAssignee(req, step)) return res.status(403).json({ message: "Not allowed" });
    if (manage) {
      Object.assign(step, sanitizeStepBody(req.body || {}, { allowWeightOrder: true }));
    } else {
      // Assigned member: cannot touch weight/order/assignee/title — progress & notes only.
      const limited = sanitizeStepBody({ progress: req.body?.progress, notes: req.body?.notes, description: req.body?.description }, { allowWeightOrder: false });
      Object.assign(step, limited);
    }
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("update step error:", err.message);
    return res.status(400).json({ message: err.message || "Could not update step" });
  }
});

// PATCH /api/project-steps/:id/status
router.patch("/project-steps/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ message: "Invalid step status" });
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    const manage = canManageSteps(req, project);
    if (!manage) {
      // Members may only move pending -> in_progress on their own step.
      if (!isAssignee(req, step) || !(step.status === "pending" && status === "in_progress")) {
        return res.status(403).json({ message: "Not allowed" });
      }
    }
    step.status = status;
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("step status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/project-steps/:id/progress
router.patch("/project-steps/:id/progress", async (req, res) => {
  try {
    const progress = clamp(req.body?.progress);
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!canManageSteps(req, project) && !isAssignee(req, step)) return res.status(403).json({ message: "Not allowed" });
    step.progress = progress;
    if (progress > 0 && step.status === "pending") step.status = "in_progress";
    if (req.body?.notes !== undefined) step.notes = req.body.notes || "";
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("step progress error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/project-steps/:id/submit
router.patch("/project-steps/:id/submit", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!canManageSteps(req, project) && !isAssignee(req, step)) return res.status(403).json({ message: "Not allowed" });
    if (clamp(step.progress) < 100) {
      if (req.body?.progress !== undefined && clamp(req.body.progress) >= 100) step.progress = 100;
      else return res.status(400).json({ message: "Complete the step (100%) before submitting." });
    }
    if (req.body?.notes !== undefined) step.notes = req.body.notes || "";
    step.status = "submitted";
    step.submittedAt = new Date();
    step.submittedBy = req.user.id;
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("step submit error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/project-steps/:id/review  { decision: approve|reject, reviewNote }
router.patch("/project-steps/:id/review", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!canManageSteps(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can review steps." });
    if (String(step.submittedBy || "") === me(req)) return res.status(403).json({ message: "You cannot review your own submitted step." });
    const decision = req.body?.decision;
    if (!["approve", "reject"].includes(decision)) return res.status(400).json({ message: "decision must be approve or reject" });
    if (decision === "approve") {
      step.status = "approved";
      step.progress = 100;
    } else {
      step.status = "rejected";
    }
    step.reviewNote = req.body?.reviewNote || "";
    step.reviewedAt = new Date();
    step.reviewedBy = req.user.id;
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("step review error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/project-steps/:id/approval  -> prepare (and optionally send) a customer approval
// body: { title, message, attachments[], links[], send }
router.put("/project-steps/:id/approval", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!canManageSteps(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can prepare customer approvals." });
    const b = req.body || {};
    const attachments = Array.isArray(b.attachments) ? b.attachments.filter((a) => a && a.url).map((a) => ({ name: a.name || "", url: a.url, type: a.type || "", bytes: Number(a.bytes) || 0 })) : [];
    const links = Array.isArray(b.links) ? b.links.filter((l) => l && l.url).map((l) => ({ label: l.label || "", url: l.url })) : [];

    step.requiresCustomerApproval = true;
    step.approval = {
      ...(step.approval ? step.approval.toObject?.() || step.approval : {}),
      title: b.title || step.approval?.title || "",
      message: b.message || "",
      attachments,
      links,
      preparedBy: req.user.id,
      preparedAt: new Date(),
    };
    if (b.send) {
      step.approval.sentAt = new Date();
      step.approval.respondedAt = null;
      step.approval.responderName = "";
      step.approval.customerNote = "";
      step.customerApprovalStatus = "pending";
    } else if (step.customerApprovalStatus === "not_required") {
      step.customerApprovalStatus = "pending";
    }
    step.updatedBy = req.user.id;
    await step.save();
    const out = await populateStep(ProjectStep.findById(step._id));
    return res.json(out);
  } catch (err) {
    console.error("prepare approval error:", err.message);
    return res.status(400).json({ message: err.message || "Could not prepare approval" });
  }
});

// DELETE /api/project-steps/:id (soft delete — managers only)
router.delete("/project-steps/:id", async (req, res) => {
  try {
    const { step, project } = await loadStep(req, res);
    if (!step) return;
    if (!canManageSteps(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can delete steps." });
    step.isDeleted = true;
    step.updatedBy = req.user.id;
    await step.save();
    await recalcProjectProgress(project._id);
    return res.json({ ok: true, _id: step._id });
  } catch (err) {
    console.error("delete step error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
