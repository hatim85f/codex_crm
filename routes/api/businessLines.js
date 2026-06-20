const express = require("express");

const router = express.Router();
const BusinessLine = require("../../models/BusinessLine");
const { auth, requireRole } = require("../../middleware/auth");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"];
const FIELDS = ["name", "description", "status"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const normalizeBody = (body = {}) => {
  const out = {};
  FIELDS.forEach((field) => { if (body[field] !== undefined) out[field] = body[field]; });
  if (out.name) out.name = String(out.name).trim();
  if (out.status && !["active", "inactive"].includes(out.status)) out.status = "active";
  return out;
};

router.get("/", async (req, res) => {
  try {
    const { search, status } = req.query;
    const query = { organization: req.user.organization };
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [{ name: rx }, { description: rx }];
    }
    const items = await BusinessLine.find(query).sort({ name: 1 });
    return res.json(items);
  } catch (err) {
    console.error("list business lines error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = normalizeBody(req.body);
    if (!b.name) return res.status(400).json({ message: "Business line name is required" });
    const item = await BusinessLine.create({ ...b, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    return res.status(201).json(item);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A business line with this name already exists" });
    console.error("create business line error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadBusinessLine(req, res) {
  const item = await BusinessLine.findById(req.params.id);
  if (!item || String(item.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Business line not found" });
    return null;
  }
  return item;
}

router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const item = await loadBusinessLine(req, res);
    if (!item) return;
    const b = normalizeBody(req.body);
    FIELDS.forEach((field) => { if (b[field] !== undefined) item[field] = b[field]; });
    item.updatedBy = req.user.id;
    await item.save();
    return res.json(item);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: "A business line with this name already exists" });
    console.error("update business line error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) return res.status(400).json({ message: "status must be active or inactive" });
    const item = await loadBusinessLine(req, res);
    if (!item) return;
    item.status = status;
    item.updatedBy = req.user.id;
    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("business line status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
