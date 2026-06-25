const express = require("express");

const router = express.Router();
const MetaLeadReport = require("../../models/MetaLeadReport");
const PotentialCustomer = require("../../models/PotentialCustomer");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads, assignedScope } = require("../../services/leadsScope");
const { META_LEAD_STATUSES } = require("../../models/MetaLeadReport");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin", "team_leader"];

router.use(auth);
router.use(requireRole(...INTERNAL));

// Build the base query (tenant + role scope + filters) shared by list & stats.
async function buildQuery(req) {
  const { campaignId, formId, status, assignedTo, from, to, search } = req.query;
  const query = { organization: req.user.organization };
  if (campaignId) query.campaignId = campaignId;
  if (formId) query.formId = formId;
  if (status) query.status = status;
  if (assignedTo) query.assignedTo = assignedTo;
  if (from || to) {
    query.submittedAt = {};
    if (from) query.submittedAt.$gte = new Date(from);
    if (to) query.submittedAt.$lte = new Date(to);
  }
  const and = [];
  const scope = await assignedScope(req);
  if (scope) and.push(scope);
  if (search) {
    const rx = new RegExp(String(search).trim(), "i");
    and.push({ $or: [{ fullName: rx }, { phone: rx }, { email: rx }, { campaignName: rx }, { adName: rx }] });
  }
  if (and.length) query.$and = and;
  return query;
}

// GET /meta-leads
router.get("/", async (req, res) => {
  try {
    const query = await buildQuery(req);
    const items = await MetaLeadReport.find(query)
      .populate("assignedTo", "name avatar")
      .populate("linkedPotentialCustomerId", "name status")
      .sort({ submittedAt: -1, createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list meta leads error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /meta-leads/stats  -> the small report cards/charts (must precede /:id)
router.get("/stats", async (req, res) => {
  try {
    const query = await buildQuery(req);
    const items = await MetaLeadReport.find(query).select("status campaignName formId campaignId submittedAt");
    const byKey = (field) => {
      const map = {};
      items.forEach((i) => { const k = i[field] || "Unknown"; map[k] = (map[k] || 0) + 1; });
      return Object.entries(map).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
    };
    const countStatus = (...s) => items.filter((i) => s.includes(i.status)).length;
    return res.json({
      total: items.length,
      byCampaign: byKey("campaignName"),
      byForm: byKey("formId"),
      converted: countStatus("converted_to_potential_customer"),
      ignoredInvalid: countStatus("ignored", "invalid", "duplicate"),
      contacted: countStatus("contacted"),
      qualified: countStatus("qualified"),
    });
  } catch (err) {
    console.error("meta leads stats error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Load one tenant + role-scoped lead report.
async function loadReport(req, res) {
  const report = await MetaLeadReport.findById(req.params.id)
    .populate("assignedTo", "name avatar")
    .populate("linkedPotentialCustomerId", "name status")
    .populate("duplicateOf", "fullName phone submittedAt");
  if (!report || String(report.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Lead not found" });
    return null;
  }
  if (!canSeeAllLeads(req)) {
    const scope = await assignedScope(req);
    const allowed = (scope.assignedTo.$in || []).map(String);
    if (!allowed.includes(String(report.assignedTo?._id || report.assignedTo))) {
      res.status(404).json({ message: "Lead not found" });
      return null;
    }
  }
  return report;
}

// GET /meta-leads/:id
router.get("/:id", async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    return res.json(report);
  } catch (err) {
    console.error("get meta lead error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /meta-leads/:id  (edit notes)
router.patch("/:id", async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (req.body?.notes !== undefined) report.notes = req.body.notes;
    await report.save();
    return res.json({ ok: true, _id: report._id });
  } catch (err) {
    console.error("update meta lead error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /meta-leads/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!META_LEAD_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
    const report = await loadReport(req, res);
    if (!report) return;
    report.status = status;
    await report.save();
    return res.json({ ok: true, _id: report._id, status });
  } catch (err) {
    console.error("meta lead status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /meta-leads/:id/assign
router.patch("/:id/assign", requireRole(...MANAGE), async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    report.assignedTo = req.body?.assignedTo || null;
    await report.save();
    const out = await MetaLeadReport.findById(report._id).populate("assignedTo", "name avatar");
    return res.json(out);
  } catch (err) {
    console.error("meta lead assign error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /meta-leads/:id/ignore
router.post("/:id/ignore", async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    report.status = "ignored";
    if (req.body?.notes !== undefined) report.notes = req.body.notes;
    await report.save();
    return res.json({ ok: true, _id: report._id, status: report.status });
  } catch (err) {
    console.error("meta lead ignore error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /meta-leads/:id/convert-to-potential-customer  (manual — never automatic)
router.post("/:id/convert-to-potential-customer", async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    if (report.linkedPotentialCustomerId) {
      return res.status(400).json({ message: "This lead is already linked to a potential customer." });
    }
    const lead = await PotentialCustomer.create({
      organization: req.user.organization,
      name: report.fullName || "Meta lead",
      phone: report.phone || "",
      whatsapp: report.phone || "",
      email: report.email || "",
      source: "meta_ads",
      interestedService: report.campaignName || report.adName || "",
      status: "new_inquiry",
      priority: "medium",
      assignedTo: report.assignedTo || null,
      firstMessage: (report.fieldData || []).map((f) => `${f.label || f.name}: ${f.value}`).join("\n"),
      notes: report.notes || "",
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    report.status = "converted_to_potential_customer";
    report.linkedPotentialCustomerId = lead._id;
    await report.save();
    return res.status(201).json({ report, potentialCustomer: lead });
  } catch (err) {
    console.error("meta lead convert error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /meta-leads/:id/link-potential-customer  { potentialCustomerId }
router.post("/:id/link-potential-customer", async (req, res) => {
  try {
    const report = await loadReport(req, res);
    if (!report) return;
    const pcId = req.body?.potentialCustomerId;
    if (!pcId) return res.status(400).json({ message: "potentialCustomerId is required" });
    const pc = await PotentialCustomer.findOne({ _id: pcId, organization: req.user.organization, isDeleted: false });
    if (!pc) return res.status(404).json({ message: "Potential customer not found" });
    report.linkedPotentialCustomerId = pc._id;
    report.status = "converted_to_potential_customer";
    await report.save();
    const out = await MetaLeadReport.findById(report._id).populate("linkedPotentialCustomerId", "name status");
    return res.json(out);
  } catch (err) {
    console.error("meta lead link error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
