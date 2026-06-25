const mongoose = require("mongoose");

const { Schema } = mongoose;

// Raw audit trail of every inbound Meta webhook event. We persist the payload
// BEFORE processing so nothing is ever lost, even if processing later fails.
const MetaIntegrationLogSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", default: null, index: true },

    eventType: { type: String, default: "" }, // e.g. "whatsapp.message", "leadgen", "verification"
    source: { type: String, enum: ["whatsapp", "lead_ads"], required: true, index: true },
    metaObjectId: { type: String, default: "" }, // message id / leadgen id / page id

    status: { type: String, default: "received", index: true }, // received | processed | error | ignored
    rawPayload: { type: Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MetaIntegrationLogSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model("MetaIntegrationLog", MetaIntegrationLogSchema);
