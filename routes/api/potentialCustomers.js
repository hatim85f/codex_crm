const express = require("express");

const router = express.Router();
const PotentialCustomer = require("../../models/PotentialCustomer");
const Customer = require("../../models/Customer");
const WhatsAppConversation = require("../../models/WhatsAppConversation");
const { auth, requireRole } = require("../../middleware/auth");
const { logActivity } = require("../../services/activityLog");
const { canSeeAllLeads, assignedScope } = require("../../services/leadsScope");
const { ensureAssignmentTask } = require("../../services/autoTask");
const { PC_STATUSES, PC_PRIORITIES } = require("../../models/PotentialCustomer");

// Potential Customers are restricted to owner/admin/team_leader. Regular members
// don't browse leads — they get a "call" task (with the phone) when one is assigned.
const MANAGE = ["owner_admin", "admin", "team_leader"];

router.use(auth);
router.use(requireRole(...MANAGE));

const POPULATE = [
  { path: "assignedTo", select: "name email avatar" },
  { path: "convertedCustomerId", select: "displayName" },
];

// Load one tenant-scoped lead the current user is allowed to see.
async function loadLead(req, res) {
  const lead = await PotentialCustomer.findById(req.params.id)
    .populate("assignedTo", "name email avatar")
    .populate("createdBy", "name avatar")
    .populate("followUps.by", "name avatar");
  if (!lead || lead.isDeleted || String(lead.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Potential customer not found" });
    return null;
  }
  if (!canSeeAllLeads(req)) {
    const scope = await assignedScope(req);
    const allowed = (scope.assignedTo.$in || []).map(String);
    if (!allowed.includes(String(lead.assignedTo?._id || lead.assignedTo))) {
      res.status(404).json({ message: "Potential customer not found" });
      return null;
    }
  }
  return lead;
}

// GET /potential-customers  (filters: search, status, source, priority, assignedTo)
router.get("/", async (req, res) => {
  try {
    const { search, status, source, priority, assignedTo } = req.query;
    const query = { organization: req.user.organization, isDeleted: false };
    if (status) query.status = status;
    if (source) query.source = source;
    if (priority) query.priority = priority;
    if (assignedTo) query.assignedTo = assignedTo;

    const and = [];
    const scope = await assignedScope(req);
    if (scope) and.push(scope);
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      and.push({ $or: [{ name: rx }, { companyName: rx }, { phone: rx }, { whatsapp: rx }, { email: rx }] });
    }
    if (and.length) query.$and = and;

    const items = await PotentialCustomer.find(query).populate(POPULATE).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list potential customers error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /potential-customers
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ message: "Name is required" });
    const lead = await PotentialCustomer.create({
      organization: req.user.organization,
      name: b.name,
      companyName: b.companyName || "",
      phone: b.phone || "",
      whatsapp: b.whatsapp || "",
      email: b.email || "",
      source: PotentialCustomer.PC_SOURCES?.includes(b.source) ? b.source : "manual",
      interestedService: b.interestedService || "",
      status: PC_STATUSES.includes(b.status) ? b.status : "new_inquiry",
      priority: PC_PRIORITIES.includes(b.priority) ? b.priority : "medium",
      assignedTo: b.assignedTo || null,
      firstMessage: b.firstMessage || "",
      nextFollowUpDate: b.nextFollowUpDate || null,
      notes: b.notes || "",
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    const out = await PotentialCustomer.findById(lead._id).populate(POPULATE);
    return res.status(201).json(out);
  } catch (err) {
    console.error("create potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /potential-customers/:id  (with its WhatsApp conversation, if any)
router.get("/:id", async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    const conversation = await WhatsAppConversation.findOne({
      organization: req.user.organization,
      potentialCustomerId: lead._id,
    }).sort({ lastMessageAt: -1 });
    return res.json({ lead, conversation });
  } catch (err) {
    console.error("get potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /potential-customers/:id  (general edit)
router.patch("/:id", async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    const b = req.body || {};
    const fields = ["name", "companyName", "phone", "whatsapp", "email", "source",
      "interestedService", "priority", "assignedTo", "nextFollowUpDate", "notes"];
    fields.forEach((f) => { if (b[f] !== undefined) lead[f] = b[f]; });
    if (b.assignedTo === "") lead.assignedTo = null;
    lead.updatedBy = req.user.id;
    await lead.save();
    const out = await PotentialCustomer.findById(lead._id).populate(POPULATE);
    return res.json(out);
  } catch (err) {
    console.error("update potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /potential-customers/:id  (soft delete)
router.delete("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    lead.isDeleted = true;
    lead.updatedBy = req.user.id;
    await lead.save();
    return res.json({ ok: true, _id: lead._id });
  } catch (err) {
    console.error("delete potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /potential-customers/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!PC_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
    const lead = await loadLead(req, res);
    if (!lead) return;
    lead.status = status;
    lead.updatedBy = req.user.id;
    await lead.save();
    return res.json({ ok: true, _id: lead._id, status });
  } catch (err) {
    console.error("status potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /potential-customers/:id/assign
router.patch("/:id/assign", requireRole(...MANAGE), async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    lead.assignedTo = req.body?.assignedTo || null;
    lead.updatedBy = req.user.id;
    await lead.save();
    // Hand the assignee a "call" task with the contact details + phone.
    if (lead.assignedTo) {
      const lines = [`Call ${lead.name}.`, `Phone: ${lead.phone || lead.whatsapp || "—"}`];
      if (lead.companyName) lines.push(`Company: ${lead.companyName}`);
      if (lead.email) lines.push(`Email: ${lead.email}`);
      if (lead.interestedService) lines.push(`Interested in: ${lead.interestedService}`);
      if (lead.firstMessage) lines.push(`First message: ${lead.firstMessage}`);
      await ensureAssignmentTask({
        organization: req.user.organization,
        assignedTo: lead.assignedTo,
        createdBy: req.user.id,
        type: "call",
        title: `Call ${lead.name}`,
        contactName: lead.name,
        contactPhone: lead.phone || lead.whatsapp || "",
        relatedModule: "potential_customer",
        relatedRecordId: lead._id,
        relatedLabel: lead.name,
        description: lines.join("\n"),
      });
    }
    const out = await PotentialCustomer.findById(lead._id).populate(POPULATE);
    return res.json(out);
  } catch (err) {
    console.error("assign potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /potential-customers/:id/follow-up  { note, nextFollowUpDate?, status? }
router.post("/:id/follow-up", async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    const b = req.body || {};
    if (!b.note && !b.nextFollowUpDate) return res.status(400).json({ message: "A note or next date is required" });
    lead.followUps.push({ note: b.note || "", nextFollowUpDate: b.nextFollowUpDate || null, by: req.user.id });
    if (b.nextFollowUpDate !== undefined) lead.nextFollowUpDate = b.nextFollowUpDate || null;
    if (b.status && PC_STATUSES.includes(b.status)) lead.status = b.status;
    lead.updatedBy = req.user.id;
    await lead.save();
    const out = await PotentialCustomer.findById(lead._id)
      .populate(POPULATE)
      .populate("followUps.by", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("follow-up potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /potential-customers/:id/convert-to-customer
// Creates a real Customer from the lead and links them. Idempotent: a lead already
// converted just returns its existing customer.
router.post("/:id/convert-to-customer", requireRole(...MANAGE), async (req, res) => {
  try {
    const lead = await loadLead(req, res);
    if (!lead) return;
    if (lead.convertedCustomerId) {
      return res.status(400).json({ message: "This lead is already converted to a customer." });
    }
    const b = req.body || {};
    const displayName = b.displayName || lead.companyName || lead.name;
    const customer = await Customer.create({
      organization: req.user.organization,
      type: b.type === "individual" ? "individual" : (lead.companyName ? "company" : "individual"),
      displayName,
      companyName: lead.companyName || "",
      businessLine: lead.interestedService || "",
      assignedTo: lead.assignedTo || null,
      email: lead.email || "",
      phone: lead.phone || "",
      whatsapp: lead.whatsapp || "",
      notes: lead.notes || "",
      status: "active",
    });
    lead.convertedCustomerId = customer._id;
    lead.status = "won";
    lead.updatedBy = req.user.id;
    await lead.save();

    // Re-point any WhatsApp conversation at the new customer too.
    await WhatsAppConversation.updateMany(
      { organization: req.user.organization, potentialCustomerId: lead._id },
      { customerId: customer._id }
    );

    logActivity({
      organization: req.user.organization,
      customerId: customer._id,
      type: "customer.created",
      message: `Customer "${customer.displayName}" created from a potential customer`,
      actorId: req.user.id,
    });
    return res.status(201).json({ lead, customer });
  } catch (err) {
    console.error("convert potential customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
