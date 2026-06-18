const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const router = express.Router();
const User = require("../../models/User");
const CustomerContact = require("../../models/CustomerContact");
const { auth, getSecret } = require("../../middleware/auth");

const signToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, organization: user.organization },
    getSecret(),
    { expiresIn: "7d" }
  );

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
    if (user.status === "invited") {
      return res.status(400).json({ message: "Activate your account first using the link we emailed you." });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken(user);
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
      .populate("organization", "name logo slug status")
      .populate(
        "customerId",
        "displayName companyName type status businessLine logo email phone whatsapp online tax"
      );
    if (!user) return res.status(404).json({ message: "User not found" });
    // userType, role, customerId, customerContactId are part of the document.
    return res.json(user);
  } catch (err) {
    console.error("me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/me  -> any user updates THEIR OWN profile (name, phone, password)
router.put("/me", auth, async (req, res) => {
  try {
    const { name, phone, password, avatar, jobTitle, department } = req.body || {};
    const user = await User.findById(req.user.id).select("+passwordHash");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (avatar !== undefined) user.avatar = avatar;
    if (jobTitle !== undefined) user.jobTitle = jobTitle;
    if (department !== undefined) user.department = department;
    if (password) {
      if (String(password).length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      user.passwordHash = await bcrypt.hash(password, 10);
      user.mustSetPassword = false;
    }
    await user.save();
    return res.json(user.toJSON());
  } catch (err) {
    console.error("update me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/activate-account  { token, password }  (no expiry on token)
router.post("/activate-account", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "Token and password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const activationTokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const user = await User.findOne({ activationTokenHash }).select("+activationTokenHash");
    if (!user) {
      return res.status(400).json({ message: "This activation link is invalid or has already been used." });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.status = "active";
    user.mustSetPassword = false;
    user.activationTokenHash = undefined;
    await user.save();

    if (user.customerContactId) {
      await CustomerContact.findByIdAndUpdate(user.customerContactId, { portalStatus: "active" });
    }

    const jwtToken = signToken(user);
    return res.json({ token: jwtToken, user: user.toJSON() });
  } catch (err) {
    console.error("activate error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
