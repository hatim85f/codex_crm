const mongoose = require("mongoose");

const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  {
    fileName: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
  },
  { _id: false }
);

const SupportMessageSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "SupportConversation", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    senderType: { type: String, enum: ["customer", "internal"], required: true },
    senderUserId: { type: Schema.Types.ObjectId, ref: "User", default: null }, // internal sender
    senderCustomerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null }, // portal sender
    message: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },
    isInternalNote: { type: Boolean, default: false }, // never shown to the customer
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

SupportMessageSchema.index({ organization: 1, conversationId: 1, createdAt: 1 });

module.exports = mongoose.model("SupportMessage", SupportMessageSchema);
