const mongoose = require("mongoose");

const { Schema } = mongoose;

const NotificationSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    recipientUserId: { type: Schema.Types.ObjectId, ref: "User", index: true, required: true },
    audience: { type: String, default: "" },
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    link: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: null },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

NotificationSchema.index({ organization: 1, recipientUserId: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
