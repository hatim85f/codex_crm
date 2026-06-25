const mongoose = require("mongoose");

const { Schema } = mongoose;

const STATUSES = ["open", "in_progress", "closed"];

const SupportConversationSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null }, // portal user who started it
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    subject: { type: String, default: "" },
    status: { type: String, enum: STATUSES, default: "open", index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null }, // internal handler
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: "" },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

SupportConversationSchema.index({ organization: 1, customerId: 1, lastMessageAt: -1 });

module.exports = mongoose.model("SupportConversation", SupportConversationSchema);
module.exports.SUPPORT_STATUSES = STATUSES;
