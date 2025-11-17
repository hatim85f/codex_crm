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
router.get("/:userId", auth, async (req, res) => {
  const { userId } = req.params;

  try {
    const teams = await Team.find({ manager: userId });

    return res.status(200).send({ teams });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.get("/:teamId", auth, async (req, res) => {
  const { teamId } = req.params;

  try {
    const team = await Team.findOne({ _id: teamId });

    return res.status(200).send({ team });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error " });
  }
});

// @route   POST api/team
// @desc    Create a new team
// @access  PRIVATE
router.post("/", auth, async (req, res) => {
  const { userId, name } = req.body;

  try {
    const user = await User.findOne({ _id: userId });

    const newTeam = new Team({
      organization: user.organizationId,
      name,
      manager: userId,
      members: [],
    });

    await Team.insertOne(newTeam);
    return res
      .status(200)
      .send({ message: `Team ${name} created successfully`, team: newTeam });
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

    const manager = await User.findOne({ _id: managerId });

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

    const team = await Team.findOne({ _id: teamId });

    // Send email to the new user

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

    return res.status(200).send({
      message: `User ${firstName} added successfully to ${team.name} team`,
    });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

module.exports = router;
