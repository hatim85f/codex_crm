const mongoose = require("mongoose");
const { BANK_STATEMENT_STATUSES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const BankStatementSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },

    month: { type: Number, required: true }, // 1-12
    year: { type: Number, required: true, index: true },

    statementFile: { fileName: { type: String, default: "" }, fileUrl: { type: String, default: "" } },
    notes: { type: String, default: "" },
    auditStatus: { type: String, enum: BANK_STATEMENT_STATUSES, default: "pending", index: true },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

BankStatementSchema.index({ organization: 1, year: -1, month: -1 });

module.exports = mongoose.model("BankStatement", BankStatementSchema);
