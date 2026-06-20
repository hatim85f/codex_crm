const express = require("express");

const router = express.Router();
const Organization = require("../../models/Organization");
const { auth, requireRole } = require("../../middleware/auth");

router.use(auth);

// GET /api/organizations/me -> the Codex company record (single-company CRM)
router.get("/me", async (req, res) => {
  try {
    if (!req.user.organization) {
      return res.status(404).json({ message: "No organization for this user" });
    }
    const org = await Organization.findById(req.user.organization);
    if (!org) return res.status(404).json({ message: "Organization not found" });
    return res.json(org);
  } catch (err) {
    console.error("get org error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/organizations/me -> update own org (name, logo, contact)
router.put("/me", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { name, logo, contactEmail, contactPhone, address, status } = req.body || {};
    const org = await Organization.findById(req.user.organization);
    if (!org) return res.status(404).json({ message: "Organization not found" });

    if (name !== undefined) org.name = name;
    if (logo !== undefined) org.logo = logo;
    if (contactEmail !== undefined) org.contactEmail = contactEmail;
    if (contactPhone !== undefined) org.contactPhone = contactPhone;
    if (address !== undefined) org.address = address;
    if (status !== undefined) org.status = status;

    await org.save();
    return res.json(org);
  } catch (err) {
    console.error("update org error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
