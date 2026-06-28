const mongoose = require("mongoose");
const {
  EXPENSE_CATEGORIES, EXPENSE_STATUSES, PAYMENT_METHODS, BUSINESS_LINES,
} = require("../services/accountingConstants");

const { Schema } = mongoose;

const ExpenseSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    expenseNumber: { type: Number, index: true }, // display code EXP-{n}

    title: { type: String, required: true, trim: true },
    vendor: { type: String, default: "" },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: "other", index: true },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "other", index: true },

    originalCurrency: { type: String, default: "AED" },
    originalAmount: { type: Number, default: 0 },
    aedAmount: { type: Number, default: 0, index: true }, // manually entered

    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "bank_transfer" },
    expenseDate: { type: Date, default: Date.now, index: true },

    // A single expense can carry several receipt files (split bills, multi-page, etc.).
    receiptAttachments: { type: [{ fileName: { type: String, default: "" }, fileUrl: { type: String, default: "" } }], default: [] },
    paymentProofAttachment: { fileName: { type: String, default: "" }, fileUrl: { type: String, default: "" } },

    notes: { type: String, default: "" },
    status: { type: String, enum: EXPENSE_STATUSES, default: "pending", index: true },

    // Auto-posted from an eCommerce order (so it's idempotent + traceable).
    sourceOrderProfitId: { type: Schema.Types.ObjectId, ref: "EcommerceOrderProfit", default: null, index: true },
    sourceKind: { type: String, default: "" }, // "cogs" | "fees"

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

ExpenseSchema.index({ organization: 1, expenseDate: -1 });
ExpenseSchema.index({ organization: 1, status: 1, businessLine: 1 });

module.exports = mongoose.model("Expense", ExpenseSchema);
