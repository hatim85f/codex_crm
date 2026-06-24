const Project = require("../models/Project");

// Apply a final-delivery decision to the parent Project.
// action: "approve" | "changes" | "cancel"
async function syncProjectFromDelivery(delivery, action, actor) {
  const project = await Project.findOne({ _id: delivery.projectId, isDeleted: false });
  if (!project) return null;

  if (action === "approve") {
    project.status = "completed";
    project.progress = 100;
    project.completedAt = new Date();
    project.history.push({ action: "delivery.approved", message: "Customer approved final delivery", userId: actor || null, at: new Date() });
  } else if (action === "changes") {
    // Reopen for the team to act on the requested changes.
    project.status = "waiting_customer";
    if (project.completedAt) project.completedAt = null;
    project.history.push({ action: "delivery.changes_requested", message: "Customer requested changes on final delivery", userId: actor || null, at: new Date() });
  }
  await project.save();
  return project;
}

module.exports = { syncProjectFromDelivery };
