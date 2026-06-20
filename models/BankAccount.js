const mongoose = require("mongoose");

const { Schema } = mongoose;

// A company (tenant) bank account. Multiple per organization. Used later for
// invoices (bank-transfer option) and the customer portal payments flow.
const BankAccountSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    bankName: { type: String, required: true, trim: true },
    accountHolderName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    iban: { type: String, default: "" },
    swift: { type: String, default: "" }, // SWIFT / BIC
    currency: { type: String, default: "AED" },
    branch: { type: String, default: "" },
    address: { type: String, default: "" },
    notes: { type: String, default: "" },
    isPrimary: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("BankAccount", BankAccountSchema);
