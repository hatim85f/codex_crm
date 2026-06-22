const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const QuotationTerm = require("../../models/QuotationTerm");
const { auth, requireRole } = require("../../middleware/auth");

const VIEW = ["owner_admin", "admin", "sales", "team_leader"];
const MANAGE = ["owner_admin", "admin"];
const FIELDS = ["title", "body", "categories", "appliesToServices", "appliesToServiceCategories", "businessLine", "isDefault", "isActive", "sortOrder"];

router.use(auth);
router.use(requireRole(...VIEW));

const toIdArray = (val) => (Array.isArray(val) ? val : [])
  .filter((id) => mongoose.Types.ObjectId.isValid(id));

function normalizeBody(body = {}) {
  const out = {};
  FIELDS.forEach((f) => { if (body[f] !== undefined) out[f] = body[f]; });
  if (out.title) out.title = String(out.title).trim();
  if (out.categories !== undefined) {
    const arr = (Array.isArray(out.categories) ? out.categories : [out.categories])
      .map((c) => String(c || "").trim()).filter(Boolean);
    out.categories = arr.length ? Array.from(new Set(arr)) : ["general"];
  }
  if (out.appliesToServices !== undefined) out.appliesToServices = toIdArray(out.appliesToServices);
  if (out.appliesToServiceCategories !== undefined) out.appliesToServiceCategories = toIdArray(out.appliesToServiceCategories);
  if (out.isDefault !== undefined) out.isDefault = !!out.isDefault;
  if (out.isActive !== undefined) out.isActive = !!out.isActive;
  if (out.sortOrder !== undefined) out.sortOrder = Number(out.sortOrder) || 0;
  return out;
}

// GET /api/quotation-terms — management list
router.get("/", async (req, res) => {
  try {
    const { category, businessLine, active, search } = req.query;
    const query = { organization: req.user.organization };
    if (category) query.categories = category; // matches terms that include this category
    if (businessLine) query.businessLine = businessLine;
    if (active === "true") query.isActive = true;
    if (active === "false") query.isActive = false;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [{ title: rx }, { body: rx }];
    }
    const terms = await QuotationTerm.find(query).sort({ sortOrder: 1, title: 1 });
    return res.json(terms);
  } catch (err) {
    console.error("list quotation terms error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/quotation-terms/applicable — terms to seed into a new quotation
// (active defaults + terms matching the selected services / categories / business line).
router.get("/applicable", async (req, res) => {
  try {
    const serviceIds = toIdArray(String(req.query.serviceIds || "").split(",").filter(Boolean));
    const categoryIds = toIdArray(String(req.query.categoryIds || "").split(",").filter(Boolean));
    const { businessLine } = req.query;
    const or = [{ isDefault: true }];
    if (serviceIds.length) or.push({ appliesToServices: { $in: serviceIds } });
    if (categoryIds.length) or.push({ appliesToServiceCategories: { $in: categoryIds } });
    if (businessLine) or.push({ businessLine });
    const terms = await QuotationTerm.find({ organization: req.user.organization, isActive: true, $or: or }).sort({ sortOrder: 1, title: 1 });
    return res.json(terms);
  } catch (err) {
    console.error("applicable quotation terms error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadTerm(req, res) {
  const term = await QuotationTerm.findById(req.params.id);
  if (!term || String(term.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Quotation term not found" });
    return null;
  }
  return term;
}

// GET /api/quotation-terms/:id
router.get("/:id", async (req, res) => {
  try {
    const term = await loadTerm(req, res);
    if (!term) return;
    return res.json(term);
  } catch (err) {
    console.error("get quotation term error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/quotation-terms
router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = normalizeBody(req.body);
    if (!b.title) return res.status(400).json({ message: "Title is required" });
    if (!b.body) return res.status(400).json({ message: "Body is required" });
    const term = await QuotationTerm.create({ ...b, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    return res.status(201).json(term);
  } catch (err) {
    console.error("create quotation term error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/quotation-terms/:id
router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const term = await loadTerm(req, res);
    if (!term) return;
    const b = normalizeBody(req.body);
    FIELDS.forEach((f) => { if (b[f] !== undefined) term[f] = b[f]; });
    term.updatedBy = req.user.id;
    await term.save();
    return res.json(term);
  } catch (err) {
    console.error("update quotation term error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/quotation-terms/:id/status
router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { isActive } = req.body || {};
    if (typeof isActive !== "boolean") return res.status(400).json({ message: "isActive (boolean) is required" });
    const term = await loadTerm(req, res);
    if (!term) return;
    term.isActive = isActive;
    term.updatedBy = req.user.id;
    await term.save();
    return res.json(term);
  } catch (err) {
    console.error("quotation term status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/quotation-terms/:id (hard delete — saved quotations keep their copies)
router.delete("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const term = await loadTerm(req, res);
    if (!term) return;
    await term.deleteOne();
    return res.json({ ok: true, _id: term._id });
  } catch (err) {
    console.error("delete quotation term error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
