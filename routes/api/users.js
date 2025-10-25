const express = require("express");
const router = express.Router();
const User = require("../../models/User");
const Organization = require("../../models/organization");
const auth = require("../../middleware/auth");
const bcrypt = require("bcryptjs");
const config = require("config");
const jwt = require("jsonwebtoken");

router.post("/create", async (req, res) => {
  const {
    organizationName,
    slug: rawSlug,
    address,
    phoneNumber,
    website,
    logo,
    industry,
    facebook,
    instagram,
    whatsapp,
    firstName,
    lastName,
    email,
    password,
    profilePicture,
  } = req.body;

  try {
    if (
      !organizationName ||
      !rawSlug ||
      !firstName ||
      !lastName ||
      !email ||
      !password
    ) {
      return res.status(400).json({
        message:
          "organizationName, slug, firstName, lastName, email, and password are required",
      });
    }

    const slug = String(rawSlug)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    const normEmail = String(email).toLowerCase().trim();

    const orgConflict = await Organization.findOne({
      $or: [{ slug }, { organizationName }],
    }).lean();
    if (orgConflict)
      return res
        .status(409)
        .json({ message: "Organization name or slug already in use" });

    const userConflict = await User.findOne({ email: normEmail }).lean();
    if (userConflict)
      return res.status(409).json({ message: "Email already registered" });

    try {
      const newOrganization = new Organization({
        organizationName: organizationName.trim(),
        slug,
        address,
        phoneNumber,
        website,
        logo,
        industry,
        social: {
          ...(facebook ? { facebook } : {}),
          ...(instagram ? { instagram } : {}),
          ...(whatsapp ? { whatsapp } : {}),
        },
      });

      await newOrganization.save();

      const org = newOrganization;

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = new User({
        firstName,
        lastName,
        email: normEmail,
        password: hashedPassword,
        profilePicture,
        role: "admin",
        isAuthorized: true,
        organizationId: org._id,
      });

      await user.save();

      await Organization.updateOne(
        { _id: org._id },
        { $set: { ownerId: user._id } }
      );

      const payload = {
        user: {
          id: user.id,
        },
      };

      const token = jwt.sign(payload, config.get("jwtSecret"));

      // Sanitize user before returning
      const userObj = user.toObject();
      delete userObj.password;

      // Return full org + full user + token
      return res.status(201).json({
        message: "Organization and admin user created",
        token,
        organization: org, // full org document
        user: userObj, // full user (without password)
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      if (err?.code === 11000) {
        return res.status(409).json({
          message: "Duplicate key (likely slug or email) — choose another",
        });
      }
      throw err;
    }
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Something went wrong, please try again later" });
  }
});

// @route    POST api/user
// @desc     Create a new user
// @access   Private (admin only)
router.post("/", auth, async (req, res) => {
  const { firstName, lastName, email, password, role, profilePicture } =
    req.body;

  // basic validation
  if (!firstName || !lastName || !email || !password || !role) {
    return res.status(400).json({ msg: "Please include all required fields" });
  }

  try {
    // prevent duplicate emails
    const existing = await User.findOne({ email });
    if (existing) {
      return res
        .status(500)
        .json({ message: "User with that email already exists" });
    }

    const user = new User({
      firstName,
      lastName,
      email,
      password,
      role,
      profilePicture,
    });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    await user.save();

    const payload = {
      user: {
        id: user.id,
      },
    };

    const token = jwt.sign(payload, config.get("jwtSecret"));

    return res
      .status(200)
      .json({ message: "User registered successfully", user, token });
  } catch (error) {
    console.error(error.message || error);
    res.status(500).json({ message: error.message || "Server error" });
  }
});

module.exports = router;
