const Task = require("../models/Task");
const TaskActivity = require("../models/TaskActivity");
const User = require("../models/User");
const { departmentForRole } = require("./departments");

// Create a task for an assigned member so they can act (call / WhatsApp) without
// access to the inbox or the lead record. Idempotent: if an OPEN task already
// exists for the same record + assignee, it's returned instead of duplicated.
async function ensureAssignmentTask(opts) {
  const {
    organization, assignedTo, createdBy, type = "call", title,
    contactName = "", contactPhone = "", relatedModule = "none", relatedRecordId = null,
    relatedLabel = "", description = "", priority = "high",
  } = opts;
  if (!assignedTo) return null;

  const existing = await Task.findOne({
    organization, relatedModule, relatedRecordId, assignedTo,
    isDeleted: false, status: { $nin: ["completed", "cancelled"] },
  });
  if (existing) return existing;

  // Classify by the assignee's department so it lands in the right manager view.
  let department = opts.department || "general";
  if (!opts.department) {
    const u = await User.findById(assignedTo).select("role");
    if (u) department = departmentForRole(u.role);
  }

  const taskNumber = (await Task.countDocuments({ organization })) + 1001;
  const task = await Task.create({
    organization, taskNumber, title, type, department,
    contactName, contactPhone,
    relatedModule, relatedRecordId, relatedLabel, description,
    assignedTo, createdBy, updatedBy: createdBy, priority, status: "todo",
  });
  try {
    await TaskActivity.create({ organization, taskId: task._id, type: "created", message: "Auto-created from assignment", createdBy });
  } catch (e) { /* non-fatal */ }
  return task;
}

module.exports = { ensureAssignmentTask };
