const express = require("express");
const bcrypt = require("bcryptjs");

const router = express.Router();
const User = require("../../models/User");
const Team = require("../../models/Team");
const Customer = require("../../models/Customer");
const { auth, requireRole } = require("../../middleware/auth");

// All user routes require authentication
router.use(auth);

// POST /api/users  -> create internal user
router.post("/", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { name, email, phone, role, password, status, generalTeams } = req.body || {};

    if (!name || !email || !role || !password) {
      return res.status(400).json({ message: "name, email, role and password are required" });
    }
    if (!User.ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    // admins cannot create owner_admin users
    if (req.user.role === "admin" && role === "owner_admin") {
      return res.status(403).json({ message: "Admins cannot create owner_admin users" });
    }

    const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (exists) {
      return res.status(400).json({ message: "A user with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      organization: req.user.organization, // tenant scope
      email,
      phone: phone || "",
      role,
      userType: "internal",
      status: status === "inactive" ? "inactive" : "active",
      generalTeams: Array.isArray(generalTeams) ? generalTeams : [],
      passwordHash,
    });

    return res.status(201).json(user.toJSON());
  } catch (err) {
    console.error("create user error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/users  -> list with optional filters
router.get("/", async (req, res) => {
  try {
    const { role, status, search } = req.query;
    // Team members only — customers live in the Customers module, not here.
    const query = { organization: req.user.organization, userType: "internal" };
    if (role) query.role = role;
    if (status) query.status = status;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [{ name: rx }, { email: rx }];
    }
    const users = await User.find(query)
      .populate("generalTeams", "name department")
      .sort({ createdAt: -1 });
    return res.json(users);
  } catch (err) {
    console.error("list users error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/users/:id
router.get("/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate("generalTeams", "name department");
    if (!user || String(user.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.json(user);
  } catch (err) {
    console.error("get user error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/users/:id
router.put("/:id", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target || String(target.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "User not found" });
    }

    // admins cannot modify owner_admin users
    if (req.user.role === "admin" && target.role === "owner_admin") {
      return res.status(403).json({ message: "Admins cannot modify owner_admin users" });
    }

    const { name, phone, role, status, generalTeams, password } = req.body || {};

    if (role !== undefined) {
      if (!User.ROLES.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      if (req.user.role === "admin" && role === "owner_admin") {
        return res.status(403).json({ message: "Admins cannot assign owner_admin role" });
      }
      target.role = role;
    }
    if (name !== undefined) target.name = name;
    if (phone !== undefined) target.phone = phone;
    if (status !== undefined) target.status = status;
    if (generalTeams !== undefined && Array.isArray(generalTeams)) {
      target.generalTeams = generalTeams;
    }
    if (password) {
      target.passwordHash = await bcrypt.hash(password, 10);
    }

    await target.save();
    return res.json(target.toJSON());
  } catch (err) {
    console.error("update user error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/users/:id/status  -> activate / deactivate
router.patch("/:id/status", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: "status must be 'active' or 'inactive'" });
    }
    const target = await User.findById(req.params.id);
    if (!target || String(target.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "User not found" });
    }
    if (req.user.role === "admin" && target.role === "owner_admin") {
      return res.status(403).json({ message: "Admins cannot modify owner_admin users" });
    }
    target.status = status;
    await target.save();
    return res.json(target.toJSON());
  } catch (err) {
    console.error("status user error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/users/:id  -> delete an INACTIVE user (with reference cleanup)
router.delete("/:id", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target || String(target.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "User not found" });
    }
    if (String(target._id) === String(req.user.id)) {
      return res.status(400).json({ message: "You can't delete your own account." });
    }
    if (req.user.role === "admin" && target.role === "owner_admin") {
      return res.status(403).json({ message: "Admins cannot delete owner_admin users." });
    }
    if (target.status !== "inactive") {
      return res.status(400).json({ message: "Deactivate the user before deleting." });
    }
    // Detach references so nothing is orphaned.
    await Team.updateMany(
      { organization: req.user.organization, "members.userId": target._id },
      { $pull: { members: { userId: target._id } } }
    );
    await Team.updateMany({ teamLeaderId: target._id }, { teamLeaderId: null });
    await Customer.updateMany({ assignedTo: target._id }, { assignedTo: null });

    await target.deleteOne();
    return res.json({ ok: true, _id: target._id });
  } catch (err) {
    console.error("delete user error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
