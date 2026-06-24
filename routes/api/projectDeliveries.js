const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Project = require("../../models/Project");
const ProjectStep = require("../../models/ProjectStep");
const ProjectDelivery = require("../../models/ProjectDelivery");
const Customer = require("../../models/Customer");
const User = require("../../models/User");
const Organization = require("../../models/Organization");
const { auth, requireRole } = require("../../middleware/auth");
const { sendProjectFinalDelivery } = require("../../services/emailService");
const { requestWebBase } = require("../../services/publicWeb");
const { logActivity } = require("../../services/activityLog");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader", "developer", "designer", "content_creator", "accountant", "support"];

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
    .populate("projectId", "projectName progress status")
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
  const types = ProjectDelivery.LINK_TYPES;
  return raw.filter((l) => l && l.url).map((l) => ({ label: l.label || "", url: l.url, type: types.includes(l.type) ? l.type : "other" }));
}
function sanitizeChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c) => c && c.label).map((c) => ({ label: String(c.label), isCompleted: !!c.isCompleted, notes: c.notes || "" }));
}

// GET /api/projects/:projectId/delivery
router.get("/projects/:projectId/delivery", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!(await canViewProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const items = await populate(ProjectDelivery.find({ organization: req.user.organization, projectId: project._id, isDeleted: false })).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list deliveries error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/project-deliveries/by-customer/:customerId
router.get("/project-deliveries/by-customer/:customerId", async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.customerId, organization: req.user.organization });
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const items = await populate(ProjectDelivery.find({ organization: req.user.organization, customerId: customer._id, isDeleted: false })).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("deliveries by customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/projects/:projectId/delivery  (managers only)
router.post("/projects/:projectId/delivery", async (req, res) => {
  try {
    const project = await loadProject(req, res, req.params.projectId);
    if (!project) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can prepare a final delivery." });
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ message: "Delivery title is required" });
    const checklist = b.handoverChecklist !== undefined
      ? sanitizeChecklist(b.handoverChecklist)
      : ProjectDelivery.DEFAULT_CHECKLIST.map((label) => ({ label, isCompleted: false, notes: "" }));
    const delivery = new ProjectDelivery({
      organization: req.user.organization,
      projectId: project._id,
      customerId: project.customerId,
      title: String(b.title).trim(),
      message: b.message || "",
      status: "draft",
      deliveryFiles: sanitizeFiles(b.deliveryFiles, req),
      deliveryLinks: sanitizeLinks(b.deliveryLinks),
      handoverChecklist: checklist,
      internalNotes: b.internalNotes || "",
      dueDate: b.dueDate || null,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    await delivery.save();
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("create delivery error:", err.message);
    return res.status(400).json({ message: err.message || "Could not create delivery" });
  }
});

async function loadDelivery(req, res) {
  const delivery = await ProjectDelivery.findOne({ _id: req.params.id, organization: req.user.organization, isDeleted: false });
  if (!delivery) { res.status(404).json({ message: "Delivery not found" }); return {}; }
  const project = await Project.findOne({ _id: delivery.projectId, organization: req.user.organization });
  return { delivery, project };
}

// GET /api/project-deliveries/:id
router.get("/project-deliveries/:id", async (req, res) => {
  try {
    const { delivery, project } = await loadDelivery(req, res);
    if (!delivery) return;
    if (project && !(await canViewProject(req, project))) return res.status(403).json({ message: "Not allowed" });
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.json(out);
  } catch (err) {
    console.error("get delivery error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/project-deliveries/:id  (edit while draft or after changes requested)
router.put("/project-deliveries/:id", async (req, res) => {
  try {
    const { delivery, project } = await loadDelivery(req, res);
    if (!delivery) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Not allowed" });
    if (!["draft", "changes_requested"].includes(delivery.status)) return res.status(400).json({ message: "Only draft or returned deliveries can be edited." });
    const b = req.body || {};
    if (b.title !== undefined) delivery.title = String(b.title).trim();
    if (b.message !== undefined) delivery.message = b.message;
    if (b.deliveryFiles !== undefined) delivery.deliveryFiles = sanitizeFiles(b.deliveryFiles, req);
    if (b.deliveryLinks !== undefined) delivery.deliveryLinks = sanitizeLinks(b.deliveryLinks);
    if (b.handoverChecklist !== undefined) delivery.handoverChecklist = sanitizeChecklist(b.handoverChecklist);
    if (b.internalNotes !== undefined) delivery.internalNotes = b.internalNotes;
    if (b.dueDate !== undefined) delivery.dueDate = b.dueDate || null;
    delivery.updatedBy = req.user.id;
    await delivery.save();
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.json(out);
  } catch (err) {
    console.error("update delivery error:", err.message);
    return res.status(400).json({ message: err.message || "Could not update delivery" });
  }
});

// PATCH /api/project-deliveries/:id/send
router.patch("/project-deliveries/:id/send", async (req, res) => {
  try {
    const { delivery, project } = await loadDelivery(req, res);
    if (!delivery) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can send a final delivery." });
    if (!["draft", "changes_requested", "sent_to_customer", "viewed"].includes(delivery.status)) {
      return res.status(400).json({ message: "This delivery can no longer be sent." });
    }
    delivery.status = "sent_to_customer";
    delivery.sentAt = new Date();
    delivery.sentBy = req.user.id;
    delivery.viewedAt = null;
    delivery.approvedAt = null;
    delivery.rejectedAt = null;
    delivery.customerComment = "";
    delivery.respondedBy = null;
    delivery.updatedBy = req.user.id;
    await delivery.save();

    let emailError = null;
    try {
      const [customer, org, leaderProject] = await Promise.all([
        Customer.findById(delivery.customerId).select("displayName companyName firstName lastName email"),
        Organization.findById(req.user.organization).select("name"),
        Project.findById(delivery.projectId).populate("projectLeaderId", "name"),
      ]);
      const portalUsers = await User.find({ organization: req.user.organization, customerId: delivery.customerId, userType: "customer", status: { $ne: "inactive" } }).select("name email");
      const candidates = [...portalUsers.map((u) => ({ email: u.email, name: u.name })), { email: customer?.email, name: customer?.displayName }];
      const unique = new Map();
      candidates.forEach((r) => { const a = String(r.email || "").trim().toLowerCase(); if (a && !unique.has(a)) unique.set(a, { email: a, name: r.name || a }); });
      const recipients = [...unique.values()];
      if (recipients.length) {
        const nameParts = String(recipients[0].name || "").trim().split(/\s+/);
        await sendProjectFinalDelivery({
          recipients,
          firstName: customer?.firstName || nameParts[0] || "",
          lastName: customer?.lastName || nameParts.slice(1).join(" "),
          customerName: customer?.displayName || customer?.companyName || "",
          projectName: leaderProject?.projectName || "",
          deliveryTitle: delivery.title,
          deliveryMessage: delivery.message,
          deliveryLink: `${requestWebBase(req)}/portal/deliveries`,
          dueDate: delivery.dueDate ? new Date(delivery.dueDate).toISOString().slice(0, 10) : "—",
          teamLeader: leaderProject?.projectLeaderId?.name || "our team",
          companyName: org?.name || "Codex",
        });
      } else {
        emailError = "No customer email on file — the delivery is visible in the portal but no email was sent.";
      }
    } catch (e) {
      emailError = e.message || "Email could not be sent, but the delivery is live in the portal.";
    }

    logActivity({ organization: req.user.organization, customerId: delivery.customerId, type: "project.delivery.sent", message: `Final delivery "${delivery.title}" sent to customer`, actorId: req.user.id });
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.json({ delivery: out, emailError });
  } catch (err) {
    console.error("send delivery error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/project-deliveries/:id/cancel
router.patch("/project-deliveries/:id/cancel", async (req, res) => {
  try {
    const { delivery, project } = await loadDelivery(req, res);
    if (!delivery) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can cancel a delivery." });
    if (delivery.status === "approved") return res.status(400).json({ message: "An approved delivery cannot be cancelled." });
    delivery.status = "cancelled";
    delivery.updatedBy = req.user.id;
    await delivery.save();
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.json(out);
  } catch (err) {
    console.error("cancel delivery error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/project-deliveries/:id (soft delete)
router.delete("/project-deliveries/:id", async (req, res) => {
  try {
    const { delivery, project } = await loadDelivery(req, res);
    if (!delivery) return;
    if (!canManage(req, project)) return res.status(403).json({ message: "Only the project leader or an admin can delete a delivery." });
    delivery.isDeleted = true;
    delivery.updatedBy = req.user.id;
    await delivery.save();
    return res.json({ ok: true, _id: delivery._id });
  } catch (err) {
    console.error("delete delivery error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
