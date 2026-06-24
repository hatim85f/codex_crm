const mongoose = require("mongoose");

const { Schema } = mongoose;

const SENDER_TYPES = ["internal", "customer"];
const VISIBILITIES = ["shared", "internal_only"];

const AttachmentSchema = new Schema(
  {
    fileName: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ProjectCommentSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    projectStepId: { type: Schema.Types.ObjectId, ref: "ProjectStep", default: null },
    approvalId: { type: Schema.Types.ObjectId, ref: "ProjectApproval", default: null },
    deliveryId: { type: Schema.Types.ObjectId, ref: "ProjectDelivery", default: null },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },

    message: { type: String, required: true, trim: true },
    senderType: { type: String, enum: SENDER_TYPES, required: true },
    senderUserId: { type: Schema.Types.ObjectId, ref: "User", default: null }, // internal or customer portal user
    parentCommentId: { type: Schema.Types.ObjectId, ref: "ProjectComment", default: null },
    visibility: { type: String, enum: VISIBILITIES, default: "shared" },
    attachments: { type: [AttachmentSchema], default: [] },

    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ProjectCommentSchema.index({ organization: 1, projectId: 1, createdAt: 1 });

module.exports = mongoose.model("ProjectComment", ProjectCommentSchema);
module.exports.SENDER_TYPES = SENDER_TYPES;
module.exports.VISIBILITIES = VISIBILITIES;
