const mongoose = require("mongoose");

const { Schema } = mongoose;

const DELIVERY_STATUSES = ["draft", "sent_to_customer", "viewed", "approved", "changes_requested", "cancelled"];
const LINK_TYPES = ["website", "app_build", "google_drive", "figma", "document", "admin_panel", "other"];

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

const ChecklistSchema = new Schema(
  {
    label: { type: String, required: true },
    isCompleted: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const ProjectDeliverySchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },

    title: { type: String, required: true, trim: true },
    message: { type: String, default: "" },
    status: { type: String, enum: DELIVERY_STATUSES, default: "draft", index: true },

    deliveryFiles: { type: [FileSchema], default: [] },
    deliveryLinks: { type: [LinkSchema], default: [] },
    handoverChecklist: { type: [ChecklistSchema], default: [] },

    customerComment: { type: String, default: "" },
    internalNotes: { type: String, default: "" }, // never exposed to the customer portal

    sentAt: { type: Date, default: null },
    viewedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    dueDate: { type: Date, default: null },

    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    respondedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ProjectDeliverySchema.index({ organization: 1, customerId: 1, status: 1 });
ProjectDeliverySchema.index({ organization: 1, projectId: 1, createdAt: -1 });

// Default handover checklist suggested when preparing a delivery (frontend may override).
ProjectDeliverySchema.statics.DEFAULT_CHECKLIST = [
  "Final deliverables shared",
  "Website/app link shared",
  "Admin access instructions shared",
  "Required files/documents shared",
  "Customer reviewed the delivery",
  "Customer approval received",
];

module.exports = mongoose.model("ProjectDelivery", ProjectDeliverySchema);
module.exports.DELIVERY_STATUSES = DELIVERY_STATUSES;
module.exports.LINK_TYPES = LINK_TYPES;
