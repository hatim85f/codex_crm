const express = require("express");

const router = express.Router();
const Notification = require("../../models/Notification");
const { auth } = require("../../middleware/auth");

router.use(auth);

router.get("/", async (req, res) => {
  try {
    const notifications = await Notification.find({
      organization: req.user.organization,
      recipientUserId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .limit(50);
    return res.json(notifications);
  } catch (err) {
    console.error("list notifications error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/unread-count", async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      organization: req.user.organization,
      recipientUserId: req.user.id,
      read: false,
    });
    return res.json({ count });
  } catch (err) {
    console.error("notification count error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/read-all", async (req, res) => {
  try {
    await Notification.updateMany(
      { organization: req.user.organization, recipientUserId: req.user.id, read: false },
      { $set: { read: true, readAt: new Date() } }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("mark notifications read error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findOne({
      _id: req.params.id,
      organization: req.user.organization,
      recipientUserId: req.user.id,
    });
    if (!notification) return res.status(404).json({ message: "Notification not found" });
    if (!notification.read) {
      notification.read = true;
      notification.readAt = new Date();
      await notification.save();
    }
    return res.json(notification);
  } catch (err) {
    console.error("mark notification read error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
