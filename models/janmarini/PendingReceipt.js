const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// Raw staging area: the daily sync only fetches+stores these (deterministic, no
// judgment calls). Matching a receipt to a Shopify order/Purchase and filling in
// missing fields is done afterwards (by Hatim or the Claude agent reviewing them).
const AttachmentSchema = new Schema(
  { fileName: { type: String, default: "" }, url: { type: String, required: true } },
  { _id: false }
);

const PendingReceiptSchema = new Schema(
  {
    source: { type: String, enum: ["mariniorders", "ebay", "shopandship"], required: true, index: true },
    messageUid: { type: Number, required: true },
    messageId: { type: String, default: "", index: true }, // stable dedupe key for mailboxes we can't mark \Seen on
    subject: { type: String, default: "" },
    from: { type: String, default: "" },
    receivedAt: { type: Date, default: null },
    bodyText: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },
    status: { type: String, enum: ["pending", "processed", "needs_review", "ignored"], default: "pending", index: true },
    matchedPurchase: { type: Schema.Types.ObjectId, ref: "Purchase", default: null },
    // Set by the automatic AI parsing pass (services/janmariniReceiptParser.js).
    // Kept for audit — lets a human see exactly what the model read and why it
    // did/didn't apply the result automatically.
    aiConfidence: { type: String, enum: ["", "high", "low"], default: "" },
    aiNotes: { type: String, default: "" },
    aiParsed: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports = conn.model("PendingReceipt", PendingReceiptSchema);
