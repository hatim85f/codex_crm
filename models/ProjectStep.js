const mongoose = require("mongoose");

const { Schema } = mongoose;

const STEP_STATUSES = ["pending", "in_progress", "submitted", "approved", "rejected", "completed"];
const CUSTOMER_APPROVAL_STATUSES = ["not_required", "pending", "approved", "rejected"];

const ProjectStepSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },

    stepTitle: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },

    weight: { type: Number, required: true, default: 0, min: 0 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: STEP_STATUSES, default: "pending", index: true },
    dueDate: { type: Date, default: null },
    order: { type: Number, default: 0 },

    // Customer approval workflow — full request lives in the ProjectApproval collection.
    requiresCustomerApproval: { type: Boolean, default: false },
    customerApprovalStatus: { type: String, enum: CUSTOMER_APPROVAL_STATUSES, default: "not_required" },
    activeApprovalId: { type: Schema.Types.ObjectId, ref: "ProjectApproval", default: null },

    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewNote: { type: String, default: "" },

    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ProjectStepSchema.index({ organization: 1, projectId: 1, order: 1 });
ProjectStepSchema.index({ organization: 1, assignedTo: 1, status: 1 });

module.exports = mongoose.model("ProjectStep", ProjectStepSchema);
module.exports.STEP_STATUSES = STEP_STATUSES;
module.exports.CUSTOMER_APPROVAL_STATUSES = CUSTOMER_APPROVAL_STATUSES;
