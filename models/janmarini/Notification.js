const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// Created either (a) when a confirmed purchase receipt indicates an item
// reached a warehouse/courier milestone (delivered to the forwarder's
// warehouse — e.g. Shipito), or (b) directly at mailbox-parse time for
// informational-only eBay mail (seller messages, cancellations, refunds) —
// nothing to confirm/apply there, just something the owner should see. Read-
// only for the owner dashboard; nothing downstream depends on these beyond
// display.
const NotificationSchema = new Schema(
  {
    orderNumber: { type: String, default: "" },
    itemName: { type: String, default: "" },
    message: { type: String, required: true },
    type: { type: String, enum: ["delivered_to_warehouse", "informational", "other"], default: "other" },
    source: { type: String, enum: ["ebay", "shopandship", "other"], default: "other" },
    read: { type: Boolean, default: false, index: true },
    receiptFiles: { type: [String], default: [] }, // Cloudinary URLs carried over from the source PendingReceipt attachment(s)
  },
  { timestamps: true }
);

module.exports = conn.model("JanmariniNotification", NotificationSchema);
