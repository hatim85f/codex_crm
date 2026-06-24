const ProjectStep = require("../models/ProjectStep");
const { recalcProjectProgress } = require("./projectProgress");

// Apply an approval lifecycle action to the linked ProjectStep, then recalc project progress.
// action: "send" | "approve" | "reject" | "cancel"
async function syncStepFromApproval(approval, action) {
  const step = await ProjectStep.findOne({ _id: approval.projectStepId, isDeleted: false });
  if (!step) return;
  step.requiresCustomerApproval = true;

  if (action === "send") {
    step.customerApprovalStatus = "pending";
    if (["pending", "in_progress"].includes(step.status)) step.status = "submitted";
    step.activeApprovalId = approval._id;
  } else if (action === "approve") {
    step.customerApprovalStatus = "approved";
    step.status = "approved";
    step.progress = 100;
  } else if (action === "reject") {
    step.customerApprovalStatus = "rejected";
    step.status = "rejected";
  } else if (action === "cancel") {
    if (step.customerApprovalStatus === "pending") step.customerApprovalStatus = "not_required";
    if (String(step.activeApprovalId || "") === String(approval._id)) step.activeApprovalId = null;
  }
  await step.save();
  await recalcProjectProgress(step.projectId);
  return step;
}

module.exports = { syncStepFromApproval };
