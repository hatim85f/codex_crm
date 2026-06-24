const mongoose = require("mongoose");

const { Schema } = mongoose;

const APPROVAL_STATUSES = ["draft", "sent_to_customer", "viewed", "approved", "rejected", "cancelled", "expired"];
const APPROVAL_TYPES = ["design_approval", "marketing_plan", "content_approval", "document_review", "final_delivery", "general_approval"];
const LINK_TYPES = ["figma", "google_drive", "website", "document", "other"];

const FileSchema = new Schema(
  {
    fileName: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const LinkSchema = new Schema(
  {
    label: { type: String, default: "" },
    url: { type: String, required: true },
    type: { type: String, enum: LINK_TYPES, default: "other" },
  },
  { _id: false }
);

const ProjectApprovalSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    projectStepId: { type: Schema.Types.ObjectId, ref: "ProjectStep", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },

    title: { type: String, required: true, trim: true },
    message: { type: String, default: "" },
    approvalType: { type: String, enum: APPROVAL_TYPES, default: "general_approval" },
    status: { type: String, enum: APPROVAL_STATUSES, default: "draft", index: true },

    files: { type: [FileSchema], default: [] },
    links: { type: [LinkSchema], default: [] },

    customerComment: { type: String, default: "" },
    internalNotes: { type: String, default: "" }, // never exposed to the customer portal

    sentAt: { type: Date, default: null },
    viewedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },

    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    respondedBy: { type: Schema.Types.ObjectId, ref: "User", default: null }, // customer portal user

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ProjectApprovalSchema.index({ organization: 1, customerId: 1, status: 1 });
ProjectApprovalSchema.index({ organization: 1, projectId: 1, createdAt: -1 });

module.exports = mongoose.model("ProjectApproval", ProjectApprovalSchema);
module.exports.APPROVAL_STATUSES = APPROVAL_STATUSES;
module.exports.APPROVAL_TYPES = APPROVAL_TYPES;
module.exports.LINK_TYPES = LINK_TYPES;
