const mongoose = require("mongoose");

const { Schema } = mongoose;

const PROJECT_STATUSES = ["not_started", "in_progress", "waiting_customer", "under_review", "completed", "cancelled", "on_hold"];

// Services are COPIED from the quotation so the project keeps its own snapshot.
const ProjectServiceSchema = new Schema(
  {
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", default: null },
    serviceName: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    quantity: { type: Number, default: 1 },
    unitLabel: { type: String, default: "unit" },
  },
  { _id: false }
);

const HistorySchema = new Schema(
  {
    action: { type: String, required: true, trim: true },
    message: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ProjectSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    projectName: { type: String, required: true, trim: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    quotationId: { type: Schema.Types.ObjectId, ref: "Quotation", default: null, index: true },
    services: { type: [ProjectServiceSchema], default: [] },
    projectType: { type: String, default: "" },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    isOngoing: { type: Boolean, default: false },
    status: { type: String, enum: PROJECT_STATUSES, default: "not_started", index: true },
    projectLeaderId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedMembers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    progress: { type: Number, default: 0, min: 0, max: 100 },
    // Steps (Phase 2): when a project has steps, progress is computed from weighted steps.
    hasSteps: { type: Boolean, default: false },
    progressCalculationMode: { type: String, enum: ["manual", "steps"], default: "steps" },
    completedAt: { type: Date, default: null }, // set when customer approves final delivery
    notes: { type: String, default: "" },
    internalNotes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true }
);

ProjectSchema.index({ organization: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Project", ProjectSchema);
module.exports.PROJECT_STATUSES = PROJECT_STATUSES;
