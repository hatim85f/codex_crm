const mongoose = require("mongoose");

const { Schema } = mongoose;

const ACTIVITY_TYPES = [
  "created", "comment", "status_change", "reassigned",
  "rescheduled", "attachment", "completed", "cancelled",
];

// Append-only audit/timeline for a task: comments + every change.
const TaskActivitySchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    message: { type: String, default: "" },
    oldValue: { type: String, default: "" },
    newValue: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

TaskActivitySchema.index({ organization: 1, taskId: 1, createdAt: 1 });

module.exports = mongoose.model("TaskActivity", TaskActivitySchema);
module.exports.TASK_ACTIVITY_TYPES = ACTIVITY_TYPES;
