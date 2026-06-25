const mongoose = require("mongoose");

const { Schema } = mongoose;

const STATUSES = ["new", "in_review", "replied", "closed"];
const CATEGORIES = ["general_inquiry", "project_support", "billing_invoice", "change_request", "technical_issue", "other"];

const AttachmentSchema = new Schema(
  {
    fileName: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
  },
  { _id: false }
);

const ContactMessageSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignedHandlerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: "" },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    category: { type: String, enum: CATEGORIES, default: "general_inquiry" },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    attachments: { type: [AttachmentSchema], default: [] },
    status: { type: String, enum: STATUSES, default: "new", index: true },
    emailSentTo: { type: [String], default: [] },
    source: { type: String, default: "customer_portal" },
    internalNotes: { type: String, default: "" }, // never exposed to the customer
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ContactMessageSchema.index({ organization: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("ContactMessage", ContactMessageSchema);
module.exports.CONTACT_STATUSES = STATUSES;
module.exports.CONTACT_CATEGORIES = CATEGORIES;
