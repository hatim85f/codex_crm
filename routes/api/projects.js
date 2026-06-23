const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Project = require("../../models/Project");
const Customer = require("../../models/Customer");
const Quotation = require("../../models/Quotation");
const User = require("../../models/User");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader", "developer", "designer", "content_creator", "accountant", "support"];
const CREATE = ["owner_admin", "admin", "team_leader"];
const DELETE_ROLES = ["owner_admin", "admin"];
const STATUSES = Project.PROJECT_STATUSES;
const FIELDS = ["projectName", "customerId", "quotationId", "projectType", "startDate", "endDate", "isOngoing", "status", "projectLeaderId", "assignedMembers", "progress", "notes", "internalNotes", "services"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const canSeeAll = (req) => ["owner_admin", "admin"].includes(req.user.role);

function addHistory(doc, action, message, req) {
  doc.history.push({ action, message, userId: req.user.id, at: new Date() });
}

// Non-admins only see projects they lead / are assigned to (sales also: their customers').
async function visibilityQuery(req) {
  const base = { organization: req.user.organization, isDeleted: false };
  if (canSeeAll(req)) return base;
  const me = req.user.id;
  const or = [{ projectLeaderId: me }, { assignedMembers: me }];
  if (req.user.role === "sales") {
    const custs = await Customer.find({ organization: req.user.organization, $or: [{ assignedTo: me }, { assignees: me }] }).select("_id").lean();
    if (custs.length) or.push({ customerId: { $in: custs.map((c) => c._id) } });
  }
  return { ...base, $or: or };
}

async function canManageProject(req, project) {
  if (canSeeAll(req)) return true;
  return String(project.projectLeaderId || "") === String(req.user.id);
}

function populate(query) {
  return query
    .populate("customerId", "displayName companyName email")
    .populate("quotationId", "quotationNumber status grandTotal")
    .populate("projectLeaderId", "name email avatar")
    .populate("assignedMembers", "name email avatar role")
    .populate("createdBy", "name email");
}

function sanitizeServices(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    serviceId: s && s.serviceId && mongoose.Types.ObjectId.isValid(s.serviceId) ? s.serviceId : null,
    serviceName: String((s && s.serviceName) || "").trim(),
    description: (s && s.description) || "",
    quantity: s && s.quantity !== undefined ? Number(s.quantity) || 1 : 1,
    unitLabel: (s && s.unitLabel) || "unit",
  })).filter((s) => s.serviceName);
}

async function buildPayload(req, body, existing) {
  if (!body.projectName) throw new Error("Project name is required");
  if (!body.customerId || !mongoose.Types.ObjectId.isValid(body.customerId)) throw new Error("Valid customer is required");
  const customer = await Customer.findById(body.customerId).select("organization");
  if (!customer || String(customer.organization) !== String(req.user.organization)) throw new Error("Customer not found");
  const out = {
    projectName: String(body.projectName).trim(),
    customerId: body.customerId,
    quotationId: body.quotationId || (existing ? existing.quotationId : null),
    projectType: body.projectType || "",
    startDate: body.startDate || null,
    endDate: body.isOngoing ? null : (body.endDate || null),
    isOngoing: !!body.isOngoing,
    status: STATUSES.includes(body.status) ? body.status : "not_started",
    projectLeaderId: body.projectLeaderId || null,
    assignedMembers: Array.isArray(body.assignedMembers) ? body.assignedMembers.filter((id) => mongoose.Types.ObjectId.isValid(id)) : [],
    progress: Math.max(0, Math.min(100, Number(body.progress) || 0)),
    notes: body.notes || "",
    internalNotes: body.internalNotes || "",
  };
  if (body.services !== undefined) out.services = sanitizeServices(body.services);
  return out;
}

// GET /api/projects
router.get("/", async (req, res) => {
  try {
    const query = await visibilityQuery(req);
    const { search, status, projectLeaderId } = req.query;
    if (status) query.status = status;
    if (projectLeaderId) query.projectLeaderId = projectLeaderId;
    if (search) query.projectName = new RegExp(String(search).trim(), "i");
    const projects = await populate(Project.find(query)).sort({ createdAt: -1 });
    return res.json(projects);
  } catch (err) {
    console.error("list projects error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/projects/by-customer/:customerId
router.get("/by-customer/:customerId", async (req, res) => {
  try {
    const projects = await populate(Project.find({ organization: req.user.organization, customerId: req.params.customerId, isDeleted: false })).sort({ createdAt: -1 });
    return res.json(projects);
  } catch (err) {
    console.error("projects by customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/projects
router.post("/", requireRole(...CREATE), async (req, res) => {
  try {
    const payload = await buildPayload(req, req.body || {});
    const project = new Project({ ...payload, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    addHistory(project, "project.created", `Project "${project.projectName}" created`, req);
    await project.save();
    const out = await populate(Project.findById(project._id));
    return res.status(201).json(out);
  } catch (err) {
    return res.status(400).json({ message: err.message || "Could not create project" });
  }
});

// POST /api/projects/from-quotation/:quotationId  { confirm }
router.post("/from-quotation/:quotationId", requireRole(...CREATE), async (req, res) => {
  try {
    const quotation = await Quotation.findById(req.params.quotationId).populate("customerId", "displayName companyName organization");
    if (!quotation || String(quotation.organization) !== String(req.user.organization)) return res.status(404).json({ message: "Quotation not found" });
    if (quotation.status !== "accepted" && quotation.status !== "converted_to_invoice") {
      return res.status(400).json({ message: "Only accepted quotations can become projects" });
    }
    // Prevent duplicates unless the user confirms.
    const existing = await Project.findOne({ organization: req.user.organization, quotationId: quotation._id, isDeleted: false });
    if (existing && !req.body?.confirm) {
      return res.status(409).json({ message: "A project already exists for this quotation.", projectId: existing._id });
    }
    const b = req.body || {};
    const services = b.services ? sanitizeServices(b.services) : (quotation.lineItems || []).map((li) => ({
      serviceId: li.serviceId || null,
      serviceName: li.serviceName,
      description: li.description || "",
      quantity: li.quantity || 1,
      unitLabel: li.unitLabel || "unit",
    }));
    const custName = quotation.customerId?.displayName || quotation.customerId?.companyName || "Customer";
    const firstService = services[0]?.serviceName;
    const suggestedName = firstService ? `${custName} — ${firstService}` : `${custName} — ${quotation.quotationNumber}`;
    const project = new Project({
      organization: req.user.organization,
      projectName: b.projectName ? String(b.projectName).trim() : suggestedName,
      customerId: quotation.customerId?._id || quotation.customerId,
      quotationId: quotation._id,
      services,
      projectType: b.projectType || "",
      status: STATUSES.includes(b.status) ? b.status : "not_started",
      startDate: b.startDate || new Date(),
      endDate: b.isOngoing ? null : (b.endDate || null),
      isOngoing: !!b.isOngoing,
      projectLeaderId: b.projectLeaderId || null,
      assignedMembers: Array.isArray(b.assignedMembers) ? b.assignedMembers.filter((id) => mongoose.Types.ObjectId.isValid(id)) : [],
      progress: Math.max(0, Math.min(100, Number(b.progress) || 0)),
      notes: b.notes || "",
      internalNotes: b.internalNotes || "",
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    addHistory(project, "project.created", `Project created from quotation ${quotation.quotationNumber}`, req);
    await project.save();
    // Link back without touching quotation pricing.
    quotation.convertedToProjectId = project._id;
    await quotation.save();
    const out = await populate(Project.findById(project._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("project from quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadProject(req, res) {
  const project = await Project.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
  if (!project) { res.status(404).json({ message: "Project not found" }); return null; }
  return project;
}

// GET /api/projects/:id
router.get("/:id", async (req, res) => {
  try {
    const project = await populate(Project.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false }));
    if (!project) return res.status(404).json({ message: "Project not found" });
    return res.json(project);
  } catch (err) {
    console.error("get project error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/projects/:id
router.put("/:id", async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    if (!(await canManageProject(req, project))) return res.status(403).json({ message: "You can only edit projects you lead." });
    const payload = await buildPayload(req, req.body || {}, project);
    Object.assign(project, payload);
    project.updatedBy = req.user.id;
    addHistory(project, "project.updated", "Project updated", req);
    await project.save();
    const out = await populate(Project.findById(project._id));
    return res.json(out);
  } catch (err) {
    return res.status(400).json({ message: err.message || "Could not update project" });
  }
});

// PATCH /api/projects/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ message: "Invalid project status" });
    const project = await loadProject(req, res);
    if (!project) return;
    if (!(await canManageProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    project.status = status;
    if (status === "completed" && project.progress < 100) project.progress = 100;
    project.updatedBy = req.user.id;
    addHistory(project, "project.status", `Status changed to ${status}`, req);
    await project.save();
    const out = await populate(Project.findById(project._id));
    return res.json(out);
  } catch (err) {
    console.error("project status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/projects/:id/progress
router.patch("/:id/progress", async (req, res) => {
  try {
    const progress = Math.max(0, Math.min(100, Number(req.body?.progress)));
    if (!Number.isFinite(progress)) return res.status(400).json({ message: "Progress must be 0–100" });
    const project = await loadProject(req, res);
    if (!project) return;
    if (!(await canManageProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    project.progress = progress;
    if (progress >= 100 && project.status !== "completed" && project.status !== "cancelled") project.status = "completed";
    project.updatedBy = req.user.id;
    addHistory(project, "project.progress", `Progress set to ${progress}%`, req);
    await project.save();
    const out = await populate(Project.findById(project._id));
    return res.json(out);
  } catch (err) {
    console.error("project progress error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/projects/:id (soft delete)
router.delete("/:id", requireRole(...DELETE_ROLES), async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    project.isDeleted = true;
    project.updatedBy = req.user.id;
    if (project.quotationId) {
      await Quotation.updateOne({ _id: project.quotationId, convertedToProjectId: project._id }, { $set: { convertedToProjectId: null } });
    }
    await project.save();
    return res.json({ ok: true, _id: project._id });
  } catch (err) {
    console.error("delete project error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
