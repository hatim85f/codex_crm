const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// Created when a confirmed purchase receipt indicates an item reached a
// warehouse/courier milestone (currently: delivered to the forwarder's
// warehouse — e.g. Shipito). Read-only for the owner dashboard; nothing
// downstream depends on these beyond display.
const NotificationSchema = new Schema(
  {
    orderNumber: { type: String, default: "" },
    itemName: { type: String, default: "" },
    message: { type: String, required: true },
    type: { type: String, enum: ["delivered_to_warehouse", "other"], default: "other" },
    read: { type: Boolean, default: false, index: true },
    receiptFiles: { type: [String], default: [] }, // Cloudinary URLs carried over from the source PendingReceipt attachment(s)
  },
  { timestamps: true }
);

module.exports = conn.model("JanmariniNotification", NotificationSchema);
