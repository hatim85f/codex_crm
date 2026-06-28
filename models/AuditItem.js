const mongoose = require("mongoose");
const { AUDIT_STATUSES } = require("../services/accountingConstants");

const { Schema } = mongoose;

// One checklist item per organization + period (year). Auto-seeded from AUDIT_ITEMS.
const AuditItemSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    period: { type: String, default: "", index: true }, // e.g. "2024"
    key: { type: String, required: true },
    label: { type: String, required: true },
    category: { type: String, default: "" },

    status: { type: String, enum: AUDIT_STATUSES, default: "missing", index: true },
    fileName: { type: String, default: "" },
    fileUrl: { type: String, default: "" },
    notes: { type: String, default: "" },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AuditItemSchema.index({ organization: 1, period: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("AuditItem", AuditItemSchema);
