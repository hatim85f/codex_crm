const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const ServiceCategory = require("../../models/ServiceCategory");
const Service = require("../../models/Service");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"];
const FIELDS = ["name", "description", "businessLine", "status"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const normalizeBody = (body = {}) => {
  const out = {};
  FIELDS.forEach((field) => {
    if (body[field] !== undefined) out[field] = body[field];
  });
  if (out.name) out.name = String(out.name).trim();
  if (out.status && !["active", "inactive"].includes(out.status)) out.status = "active";
  return out;
};

async function withCounts(req, categories) {
  const ids = categories.map((category) => category._id);
  const counts = await Service.aggregate([
    { $match: { organization: new mongoose.Types.ObjectId(String(req.user.organization)), categoryId: { $in: ids } } },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((row) => [String(row._id), row.count]));
  return categories.map((category) => ({
    ...category.toObject(),
    servicesCount: countMap.get(String(category._id)) || 0,
  }));
}

// GET /api/service-categories
router.get("/", async (req, res) => {
  try {
    const { search, status, businessLine } = req.query;
    const query = { organization: req.user.organization };
    if (status) query.status = status;
    if (businessLine) query.businessLine = businessLine;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [{ name: rx }, { description: rx }];
    }
    const categories = await ServiceCategory.find(query).sort({ name: 1 });
    return res.json(await withCounts(req, categories));
  } catch (err) {
    console.error("list service categories error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/service-categories
router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = normalizeBody(req.body);
    if (!b.name) return res.status(400).json({ message: "Category name is required" });
    const category = await ServiceCategory.create({ ...b, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    return res.status(201).json({ ...category.toObject(), servicesCount: 0 });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A category with this name already exists" });
    console.error("create service category error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadCategory(req, res) {
  const category = await ServiceCategory.findById(req.params.id);
  if (!category || String(category.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Service category not found" });
    return null;
  }
  return category;
}

// GET /api/service-categories/:id
router.get("/:id", async (req, res) => {
  try {
    const category = await loadCategory(req, res);
    if (!category) return;
    const [out] = await withCounts(req, [category]);
    return res.json(out);
  } catch (err) {
    console.error("get service category error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/service-categories/:id
router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const category = await loadCategory(req, res);
    if (!category) return;
    const b = normalizeBody(req.body);
    FIELDS.forEach((field) => { if (b[field] !== undefined) category[field] = b[field]; });
    category.updatedBy = req.user.id;
    await category.save();
    const [out] = await withCounts(req, [category]);
    return res.json(out);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A category with this name already exists" });
    console.error("update service category error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/service-categories/:id/status
router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) return res.status(400).json({ message: "status must be active or inactive" });
    const category = await loadCategory(req, res);
    if (!category) return;
    category.status = status;
    category.updatedBy = req.user.id;
    await category.save();
    const [out] = await withCounts(req, [category]);
    return res.json(out);
  } catch (err) {
    console.error("service category status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
