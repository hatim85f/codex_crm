const express = require("express");
const router = express.Router();
const auth = require("../../middleware/auth");
const User = require("../../models/User");
const Team = require("../../models/Team");
const bcrypt = require("bcryptjs");
const { sendTemplateEmail } = require("../../lib/brevo");
const moment = require("moment");

// @route   GET api/team
// @desc    Get team info
// @access  Public
router.get("/", async (req, res) => {
  return res.status(200).send({ message: "Team info endpoint" });
});

// @route   POST api/team
// @desc    Create a new team
// @access  PRIVATE
router.post("/", auth, async (req, res) => {
  const { userId, name } = req.body;

  try {
    const user = await User.findOne({ _id: userId });

    const newTeam = new Team({
      organiztion: user.organizationId,
      name,
      manager: userId,
      members: [],
    });

    await newTeam.save();

    return res
      .status(200)
      .send({ message: "Team created successfully", team: newTeam });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.put("/:teamId/add-member", auth, async (req, res) => {
  const { teamId } = req.params;
  const {
    firstName,
    lastName,
    userPhone,
    email,
    password,
    role,
    organizationId,
    managerId,
  } = req.body;

  try {
    const userPassword = password || Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(userPassword, 10);

    const newUser = new User({
      firstName,
      lastName,
      userPhone,
      email,
      password: hashedPassword,
      role,
      organizationId,
    });
    await newUser.save();

    await Team.updateOne({
      _id: teamId,
      $push: { members: newUser._id },
    });

    // Send email to the new user

    const manager = await User.findOne({ _id: managerId });

    await sendTemplateEmail({
      to: email,
      name: firstName + " " + lastName,
      templateId: 4,
      params: {
        userName: firstName + " " + lastName,
        manager: manager.fullName,
        password: userPassword,
        time: moment(new Date()).format("DD MMM YYYY, hh:mm A"),
      },
    });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

module.exports = router;
