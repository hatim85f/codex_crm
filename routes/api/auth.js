const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const config = require("config");
const { check, validationResult } = require("express-validator");
const User = require("../../models/User");
const ResetToken = require("../../models/ResetToken");
const { sendTemplateEmail } = require("../../lib/brevo");
const moment = require("moment");

// @route   POST api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post(
  "/login",

  [
    check("email", "email is required").not().isEmpty(),
    check("password", "Password is required").exists(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    if (!email) {
      return res
        .status(500)
        .send({ error: "Error", message: "Email is required" });
    }

    if (!password) {
      return res
        .status(500)
        .send({ error: "Error", message: "Password is required" });
    }

    try {
      let user = await User.findOne({ email });
      if (!user) {
        return res
          .status(400)
          .json({ error: "ERROR!", message: "Invalid username or password" });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res
          .status(400)
          .json({ error: "ERROR!", message: "Invalid username or password" });
      }

      const payload = {
        user: {
          id: user.id,
        },
      };

      const token = jwt.sign(payload, config.get("jwtSecret"));

      return res.status(200).json({ user, token });
    } catch (err) {
      console.error(err.message);
      res.status(500).send({ error: "ERROR", message: "Server error" });
    }
  }
);

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    let message = "";

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).send({
        error: "ERROR !",
        message: "User with this email does not exist.",
      });
    }

    const isResetTokenExist = await ResetToken.findOne({ user: user._id });
    if (isResetTokenExist) {
      await isResetTokenExist.deleteOne();
      message = "A new reset token has been sent to your email.";
    } else {
      message = "Password reset token generated successfully.";
    }

    const resetToken = Math.floor(10000 + Math.random() * 900000).toString();

    const newReset = new ResetToken({
      resetToken,
      user: user._id,
    });

    await newReset.save();

    await sendTemplateEmail({
      to: email,
      name: user.fullName,
      templateId: 3,
      params: {
        userName: user.fullName,
        otp: resetToken,
        time: moment(new Date()).format("DD MMM YYYY, hh:mm A"),
      },
    });

    return res.status(200).send({
      message: message,
      resetToken,
    });
  } catch (error) {
    return res.status(500).send({
      error: "ERROR !",
      message: error.message,
    });
  }
});

module.exports = router;
