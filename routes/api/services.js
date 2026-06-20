const express = require("express");

const router = express.Router();
const Service = require("../../models/Service");
const ServiceCategory = require("../../models/ServiceCategory");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"];
const FIELDS = ["serviceName", "categoryId", "businessLine", "description", "defaultPrice", "currency", "billingType", "defaultQuantity", "unitLabel", "taxable", "taxRate", "status", "notes"];

router.use(auth);
router.use(requireRole(...INTERNAL));

function normalizeBody(body = {}) {
  const out = {};
  FIELDS.forEach((field) => { if (body[field] !== undefined) out[field] = body[field]; });
  if (out.serviceName) out.serviceName = String(out.serviceName).trim();
  if (out.defaultPrice !== undefined) out.defaultPrice = Number(out.defaultPrice) || 0;
  if (out.defaultQuantity !== undefined) out.defaultQuantity = Number(out.defaultQuantity) || 0;
  if (out.taxable !== undefined) out.taxable = !!out.taxable;
  if (out.taxable === false) out.taxRate = 0;
  else if (out.taxRate !== undefined) out.taxRate = Number(out.taxRate) || 0;
  else if (out.taxable === true) out.taxRate = 5;
  return out;
}

async function categoryFor(req, categoryId) {
  if (!categoryId) return null;
  const category = await ServiceCategory.findById(categoryId);
  if (!category || String(category.organization) !== String(req.user.organization)) return null;
  return category;
}

// GET /api/services
router.get("/", async (req, res) => {
  try {
    const { search, categoryId, businessLine, billingType, status } = req.query;
    const query = { organization: req.user.organization };
    if (categoryId) query.categoryId = categoryId;
    if (businessLine) query.businessLine = businessLine;
    if (billingType) query.billingType = billingType;
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [{ serviceName: rx }, { description: rx }];
    }
    const services = await Service.find(query)
      .populate("categoryId", "name businessLine status")
      .sort({ createdAt: -1 });
    return res.json(services);
  } catch (err) {
    console.error("list services error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/services
router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = normalizeBody(req.body);
    if (!b.serviceName) return res.status(400).json({ message: "Service name is required" });
    const category = await categoryFor(req, b.categoryId);
    if (!category) return res.status(400).json({ message: "Valid category is required" });
    const service = await Service.create({
      ...b,
      businessLine: b.businessLine || category.businessLine,
      organization: req.user.organization,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    const out = await Service.findById(service._id).populate("categoryId", "name businessLine status");
    return res.status(201).json(out);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A service with this name already exists" });
    console.error("create service error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadService(req, res) {
  const service = await Service.findById(req.params.id);
  if (!service || String(service.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Service not found" });
    return null;
  }
  return service;
}

// GET /api/services/:id
router.get("/:id", async (req, res) => {
  try {
    const service = await Service.findById(req.params.id).populate("categoryId", "name businessLine status");
    if (!service || String(service.organization) !== String(req.user.organization)) return res.status(404).json({ message: "Service not found" });
    return res.json(service);
  } catch (err) {
    console.error("get service error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/services/:id
router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const service = await loadService(req, res);
    if (!service) return;
    const b = normalizeBody(req.body);
    if (b.categoryId) {
      const category = await categoryFor(req, b.categoryId);
      if (!category) return res.status(400).json({ message: "Valid category is required" });
    }
    FIELDS.forEach((field) => { if (b[field] !== undefined) service[field] = b[field]; });
    service.updatedBy = req.user.id;
    await service.save();
    const out = await Service.findById(service._id).populate("categoryId", "name businessLine status");
    return res.json(out);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A service with this name already exists" });
    console.error("update service error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/services/:id/status
router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) return res.status(400).json({ message: "status must be active or inactive" });
    const service = await loadService(req, res);
    if (!service) return;
    service.status = status;
    service.updatedBy = req.user.id;
    await service.save();
    const out = await Service.findById(service._id).populate("categoryId", "name businessLine status");
    return res.json(out);
  } catch (err) {
    console.error("service status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
