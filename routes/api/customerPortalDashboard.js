const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const Project = require("../../models/Project");
const ProjectStep = require("../../models/ProjectStep");
const ProjectApproval = require("../../models/ProjectApproval");
const ProjectDelivery = require("../../models/ProjectDelivery");
const ProjectComment = require("../../models/ProjectComment");
const Invoice = require("../../models/Invoice");
const { auth } = require("../../middleware/auth");

router.use(auth);

// ---- shared helpers --------------------------------------------------------

async function customerCtx(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.userType !== "customer" || !user.customerId) {
    res.status(403).json({ message: "Not a customer account" });
    return null;
  }
  return user;
}

async function ownProject(user, projectId) {
  return Project.findOne({
    _id: projectId,
    organization: user.organization,
    customerId: user.customerId,
    isDeleted: false,
  }).select("-internalNotes -history");
}

// Approvals/deliveries the customer is allowed to see (left draft, not cancelled).
const VISIBLE_APPROVAL = ["sent_to_customer", "viewed", "approved", "rejected"];
const VISIBLE_DELIVERY = ["sent_to_customer", "viewed", "approved", "changes_requested"];
const PENDING_RESPONSE = ["sent_to_customer", "viewed"]; // waiting on the customer

const COMPLETED_STEP = ["approved", "completed"];
const PENDING_INVOICE = ["sent", "partially_paid", "overdue", "pending_bank_verification"];

const isActiveProject = (p) =>
  p.status !== "cancelled" && (p.isOngoing || !["delivered", "completed"].includes(p.status));

const progressLabelFor = (p) => (p.isOngoing ? "Current Cycle Progress" : "Project Progress");

// Customer-safe link/file mappers.
const mapFile = (f, source, sourceTitle) => ({
  kind: "file",
  name: f.fileName || "File",
  fileType: f.fileType || "",
  url: f.fileUrl,
  sharedAt: f.uploadedAt || null,
  source,
  sourceTitle,
});
const mapLink = (l, source, sourceTitle) => ({
  kind: "link",
  name: l.label || l.url,
  linkType: l.type || "other",
  url: l.url,
  sharedAt: null,
  source,
  sourceTitle,
});

// ---- GET /dashboard --------------------------------------------------------

router.get("/dashboard", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const scope = { organization: user.organization, customerId: user.customerId, isDeleted: false };

    const [projects, approvals, deliveries, invoices] = await Promise.all([
      Project.find(scope).select("status isOngoing"),
      ProjectApproval.find({ ...scope, status: { $in: VISIBLE_APPROVAL } }).select("status sentAt"),
      ProjectDelivery.find({ ...scope, status: { $in: VISIBLE_DELIVERY } }).select("status sentAt"),
      Invoice.find({ organization: user.organization, customerId: user.customerId, sharedToPortal: true })
        .select("status grandTotal balance currency"),
    ]);

    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recentUpdates =
      approvals.filter((a) => a.sentAt && a.sentAt >= since).length +
      deliveries.filter((d) => d.sentAt && d.sentAt >= since).length;

    const pendingInvoiceList = invoices.filter((i) => PENDING_INVOICE.includes(i.status));

    return res.json({
      customerName: user.name,
      cards: {
        totalProjects: projects.length,
        activeProjects: projects.filter(isActiveProject).length,
        pendingApprovals: approvals.filter((a) => PENDING_RESPONSE.includes(a.status)).length,
        pendingDeliveries: deliveries.filter((d) => PENDING_RESPONSE.includes(d.status)).length,
        pendingInvoices: pendingInvoiceList.length,
        paidInvoices: invoices.filter((i) => i.status === "paid").length,
        partiallyPaidInvoices: invoices.filter((i) => i.status === "partially_paid").length,
        recentUpdates,
      },
      invoiceTotals: {
        currency: invoices[0]?.currency || "AED",
        pendingBalance: pendingInvoiceList.reduce((s, i) => s + (i.balance || 0), 0),
      },
    });
  } catch (err) {
    console.error("portal dashboard error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---- GET /action-center ----------------------------------------------------

router.get("/action-center", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const scope = { organization: user.organization, customerId: user.customerId, isDeleted: false };

    const [approvals, deliveries, invoices] = await Promise.all([
      ProjectApproval.find({ ...scope, status: { $in: PENDING_RESPONSE } })
        .select("title dueDate projectId sentAt")
        .populate("projectId", "projectName"),
      ProjectDelivery.find({ ...scope, status: { $in: PENDING_RESPONSE } })
        .select("title dueDate projectId sentAt")
        .populate("projectId", "projectName"),
      Invoice.find({
        organization: user.organization,
        customerId: user.customerId,
        sharedToPortal: true,
        status: { $in: PENDING_INVOICE },
      }).select("invoiceNumber dueDate balance currency status"),
    ]);

    const items = [];
    for (const a of approvals) {
      items.push({
        type: "approval",
        label: "Review approval request",
        actionLabel: "Review & Approve",
        projectId: a.projectId?._id || null,
        projectName: a.projectId?.projectName || "Project",
        title: a.title,
        dueDate: a.dueDate || null,
        sortDate: a.dueDate || a.sentAt || null,
        refId: a._id,
        route: "PortalApprovals",
      });
    }
    for (const d of deliveries) {
      items.push({
        type: "delivery",
        label: "Approve final delivery",
        actionLabel: "Review Delivery",
        projectId: d.projectId?._id || null,
        projectName: d.projectId?.projectName || "Project",
        title: d.title,
        dueDate: d.dueDate || null,
        sortDate: d.dueDate || d.sentAt || null,
        refId: d._id,
        route: "PortalDeliveries",
      });
    }
    for (const i of invoices) {
      items.push({
        type: "invoice",
        label: "Pay invoice",
        actionLabel: "Pay Invoice",
        projectId: null,
        projectName: "",
        title: `Invoice ${i.invoiceNumber}`,
        amount: i.balance || 0,
        currency: i.currency || "AED",
        dueDate: i.dueDate || null,
        sortDate: i.dueDate || null,
        refId: i._id,
        route: "PortalInvoices",
      });
    }

    // Earliest due / oldest first so the most urgent surfaces at the top.
    items.sort((x, y) => {
      if (!x.sortDate) return 1;
      if (!y.sortDate) return -1;
      return new Date(x.sortDate) - new Date(y.sortDate);
    });

    return res.json(items);
  } catch (err) {
    console.error("portal action-center error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---- GET /projects/:id/steps-summary --------------------------------------

router.get("/projects/:id/steps-summary", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const project = await ownProject(user, req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });

    // Only safe fields — never internal descriptions, notes, weight or assignee.
    const steps = await ProjectStep.find({ organization: user.organization, projectId: project._id })
      .select("stepTitle status order")
      .sort({ order: 1, createdAt: 1 });

    const totalSteps = steps.length;
    const completedSteps = steps.filter((s) => COMPLETED_STEP.includes(s.status)).length;
    const pendingSteps = totalSteps - completedSteps;

    const notDone = steps.filter((s) => !COMPLETED_STEP.includes(s.status));
    const active = notDone.find((s) => ["in_progress", "submitted"].includes(s.status));
    const current = active || notDone[0] || null;
    const next = current ? notDone.find((s) => s.order > current.order && s._id !== current._id) || null : null;

    return res.json({
      totalSteps,
      completedSteps,
      pendingSteps,
      currentStepName: current ? current.stepTitle : null,
      nextStepName: next ? next.stepTitle : null,
      progress: project.progress || 0,
      progressLabel: progressLabelFor(project),
      isOngoing: !!project.isOngoing,
    });
  } catch (err) {
    console.error("portal steps-summary error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---- GET /projects/:id/files (shared files & links) -----------------------

router.get("/projects/:id/files", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const project = await ownProject(user, req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    const scope = { organization: user.organization, projectId: project._id, isDeleted: false };

    const [approvals, deliveries] = await Promise.all([
      ProjectApproval.find({ ...scope, status: { $in: VISIBLE_APPROVAL } }).select("title files links sentAt"),
      ProjectDelivery.find({ ...scope, status: { $in: VISIBLE_DELIVERY } }).select("title deliveryFiles deliveryLinks sentAt"),
    ]);

    const out = [];
    for (const a of approvals) {
      (a.files || []).forEach((f) => out.push({ ...mapFile(f, "approval", a.title), sharedAt: f.uploadedAt || a.sentAt || null }));
      (a.links || []).forEach((l) => out.push({ ...mapLink(l, "approval", a.title), sharedAt: a.sentAt || null }));
    }
    for (const d of deliveries) {
      (d.deliveryFiles || []).forEach((f) => out.push({ ...mapFile(f, "delivery", d.title), sharedAt: f.uploadedAt || d.sentAt || null }));
      (d.deliveryLinks || []).forEach((l) => out.push({ ...mapLink(l, "delivery", d.title), sharedAt: d.sentAt || null }));
    }

    out.sort((a, b) => new Date(b.sharedAt || 0) - new Date(a.sharedAt || 0));
    return res.json(out);
  } catch (err) {
    console.error("portal files error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---- GET /projects/:id/updates (customer-safe timeline) -------------------

router.get("/projects/:id/updates", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const project = await ownProject(user, req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    const scope = { organization: user.organization, projectId: project._id, isDeleted: false };

    const [approvals, deliveries, comments] = await Promise.all([
      ProjectApproval.find({ ...scope, status: { $in: VISIBLE_APPROVAL } }).select("title sentAt approvedAt rejectedAt"),
      ProjectDelivery.find({ ...scope, status: { $in: VISIBLE_DELIVERY } }).select("title sentAt approvedAt rejectedAt"),
      ProjectComment.find({ ...scope, visibility: "shared" }).select("senderType createdAt").sort({ createdAt: -1 }).limit(15),
    ]);

    const events = [];
    const push = (at, type, text) => { if (at) events.push({ at, type, text }); };

    for (const a of approvals) {
      push(a.sentAt, "approval_sent", `Approval requested: ${a.title}`);
      push(a.approvedAt, "approval_approved", `You approved: ${a.title}`);
      push(a.rejectedAt, "approval_changes", `Changes requested: ${a.title}`);
    }
    for (const d of deliveries) {
      push(d.sentAt, "delivery_sent", `Final delivery sent: ${d.title}`);
      push(d.approvedAt, "delivery_approved", `You approved the delivery: ${d.title}`);
      push(d.rejectedAt, "delivery_changes", `You requested changes on: ${d.title}`);
    }
    for (const c of comments) {
      push(c.createdAt, "comment", c.senderType === "internal" ? "The team sent a message" : "You sent a message");
    }
    push(project.completedAt, "project_status", project.isOngoing ? "Cycle completed" : "Project completed");
    push(project.createdAt, "project_created", "Project created");

    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    return res.json(events.slice(0, 25));
  } catch (err) {
    console.error("portal updates error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
