const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();
const User = require("../../models/User");
const { auth, getSecret } = require("../../middleware/auth");

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
      "+passwordHash"
    );
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }
    if (user.status === "inactive") {
      return res.status(400).json({ message: "Account is inactive. Contact an admin." });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, organization: user.organization },
      getSecret(),
      { expiresIn: "7d" }
    );

    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error("login error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate("generalTeams", "name department")
      .populate("organization", "name logo slug status");
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json(user);
  } catch (err) {
    console.error("me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
