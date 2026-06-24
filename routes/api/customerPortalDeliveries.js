const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const ProjectDelivery = require("../../models/ProjectDelivery");
const { auth } = require("../../middleware/auth");
const { syncProjectFromDelivery } = require("../../services/deliverySync");
const { logActivity } = require("../../services/activityLog");

router.use(auth);

async function customerCtx(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.userType !== "customer" || !user.customerId) {
    res.status(403).json({ message: "Not a customer account" });
    return null;
  }
  return user;
}

const VISIBLE = ["sent_to_customer", "viewed", "approved", "changes_requested"];

function populate(query) {
  return query
    .select("-internalNotes")
    .populate("projectId", "projectName")
    .populate("sentBy", "name");
}

// GET /api/customer-portal/deliveries
router.get("/deliveries", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const items = await populate(ProjectDelivery.find({
      organization: user.organization, customerId: user.customerId, isDeleted: false, status: { $in: VISIBLE },
    })).sort({ sentAt: -1, createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("portal deliveries error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

async function loadOwn(req, res, user) {
  const delivery = await ProjectDelivery.findOne({
    _id: req.params.id, organization: user.organization, customerId: user.customerId, isDeleted: false, status: { $in: VISIBLE },
  });
  if (!delivery) { res.status(404).json({ message: "Delivery not found" }); return null; }
  return delivery;
}

// GET /api/customer-portal/deliveries/:id
router.get("/deliveries/:id", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const exists = await loadOwn(req, res, user);
    if (!exists) return;
    const out = await populate(ProjectDelivery.findById(exists._id));
    return res.json(out);
  } catch (err) {
    console.error("portal delivery error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/deliveries/:id/viewed
router.patch("/deliveries/:id/viewed", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const delivery = await loadOwn(req, res, user);
    if (!delivery) return;
    if (delivery.status === "sent_to_customer") {
      delivery.status = "viewed";
      delivery.viewedAt = new Date();
      await delivery.save();
    }
    const out = await populate(ProjectDelivery.findById(delivery._id));
    return res.json(out);
  } catch (err) {
    console.error("portal delivery viewed error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/deliveries/:id/approve
router.patch("/deliveries/:id/approve", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const delivery = await loadOwn(req, res, user);
    if (!delivery) return;
    if (!["sent_to_customer", "viewed"].includes(delivery.status)) {
      return res.status(400).json({ message: "This delivery has already been reviewed." });
    }
    delivery.status = "approved";
    delivery.approvedAt = new Date();
    delivery.customerComment = req.body?.customerComment || "";
    delivery.respondedBy = user._id;
    await delivery.save();
    await syncProjectFromDelivery(delivery, "approve", user._id);
    logActivity({ organization: user.organization, customerId: user.customerId, type: "project.delivery.approved", message: `${user.name} approved the final delivery "${delivery.title}"`, actorId: user._id, actorName: user.name });
    return res.json({ ok: true, _id: delivery._id, status: delivery.status });
  } catch (err) {
    console.error("portal delivery approve error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customer-portal/deliveries/:id/request-changes  (comment required)
router.patch("/deliveries/:id/request-changes", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const comment = String(req.body?.customerComment || "").trim();
    if (!comment) return res.status(400).json({ message: "Please add a comment describing the changes you'd like." });
    const delivery = await loadOwn(req, res, user);
    if (!delivery) return;
    if (!["sent_to_customer", "viewed"].includes(delivery.status)) {
      return res.status(400).json({ message: "This delivery has already been reviewed." });
    }
    delivery.status = "changes_requested";
    delivery.rejectedAt = new Date();
    delivery.customerComment = comment;
    delivery.respondedBy = user._id;
    await delivery.save();
    await syncProjectFromDelivery(delivery, "changes", user._id);
    logActivity({ organization: user.organization, customerId: user.customerId, type: "project.delivery.changes_requested", message: `${user.name} requested changes on the final delivery "${delivery.title}"`, actorId: user._id, actorName: user.name });
    return res.json({ ok: true, _id: delivery._id, status: delivery.status });
  } catch (err) {
    console.error("portal delivery request-changes error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
