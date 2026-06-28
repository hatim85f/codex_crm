const mongoose = require("mongoose");
const { GATEWAY_PROVIDERS, GATEWAY_STATUSES, ROW_MATCH_STATUSES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const RowSchema = new Schema(
  {
    date: { type: Date, default: null },
    orderNumber: { type: String, default: "" },
    invoiceNumber: { type: String, default: "" },
    grossAmount: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },
    netReceived: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    aedAmount: { type: Number, default: 0 },
    payoutDate: { type: Date, default: null },
    matchStatus: { type: String, enum: ROW_MATCH_STATUSES, default: "unmatched" },
  },
  { _id: false }
);

const PaymentGatewayUploadSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    provider: { type: String, enum: GATEWAY_PROVIDERS, required: true, index: true },
    month: { type: Number, default: null }, // 1-12
    year: { type: Number, default: null, index: true },

    fileName: { type: String, default: "" },
    fileUrl: { type: String, default: "" },

    status: { type: String, enum: GATEWAY_STATUSES, default: "uploaded", index: true },
    rows: { type: [RowSchema], default: [] },
    rowCount: { type: Number, default: 0 },
    totalGross: { type: Number, default: 0 },
    totalFees: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },

    notes: { type: String, default: "" },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

PaymentGatewayUploadSchema.index({ organization: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentGatewayUpload", PaymentGatewayUploadSchema);
