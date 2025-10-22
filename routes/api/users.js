const express = require("express");
const router = express.Router();
const User = require("../../models/User");
const auth = require("../../middleware/auth");
const bcrypt = require("bcryptjs");

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
