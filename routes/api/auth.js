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
      email: email,
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
      message:
        error.message || "Internal Server Error, please try again later.",
    });
  }
});

router.post("/check-reset-code", async (req, res) => {
  const { email, resetCode } = req.body;

  try {
    const resetToken = await ResetToken.findOne({
      email: email,
      resetToken: resetCode,
    });
    if (!resetToken) {
      return res.status(400).send({
        error: "ERROR !",
        message: "Invalid reset code.",
      });
    } else {
      await resetToken.deleteOne({ email: email });
    }

    return res.status(200).send({
      message: "Reset code is valid.",
    });
  } catch (error) {
    return res.status(500).send({
      error: "ERROR !",
      message: error.message,
    });
  }
});

router.put("/:userId/update-profile", auth, async (req, res) => {
  const { userId } = req.params;
  const { firstName, lastName, email, userPhone, profilePicture } = req.body;

  try {
    const user = await User.findOne({ _id: userId });

    const updatedData = {
      firstName: firstName || user.firstName,
      lastName: lastName || user.lastName,
      email: email || user.email,
      userPhone: userPhone || user.userPhone,
      profilePicture: profilePicture || user.profilePicture,
      fullName: `${firstName || user.firstName} ${lastName || user.lastName}`,
    };

    const updatedUser = await User.updateMany(
      {
        _id: userId,
      },
      {
        $set: updatedData,
      },
      { new: true }
    );

    return res.status(200).send({ user: updatedUser });
  } catch (error) {
    return res.status(500).send({
      error: "ERROR !",
      message: error.message || "Server Error",
    });
  }
});

router.put("/reset-password", async (req, rs) => {
  const { email, newPassword } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return rs.status(400).send({
        error: "ERROR !",
        message: "User with this email does not exist.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    await user.save();
    return res.status(200).send({
      message: "Password reset successfully.",
    });
  } catch (error) {
    return res.status(500).send({
      error: "ERROR !",
      message: error.message,
    });
  }
});

module.exports = router;
