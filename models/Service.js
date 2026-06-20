const mongoose = require("mongoose");
const { BUSINESS_LINES } = require("./ServiceCategory");

const { Schema } = mongoose;

const BILLING_TYPES = ["one_time", "monthly", "quarterly", "yearly", "custom"];
const CURRENCIES = ["AED", "USD"];

const ServiceSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    serviceName: { type: String, required: true, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "ServiceCategory", required: true, index: true },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "Other" },
    description: { type: String, default: "" },
    defaultPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, enum: CURRENCIES, default: "AED" },
    billingType: { type: String, enum: BILLING_TYPES, default: "one_time" },
    defaultQuantity: { type: Number, default: 1, min: 0 },
    unitLabel: { type: String, default: "project", trim: true },
    taxable: { type: Boolean, default: true },
    taxRate: { type: Number, default: 5, min: 0 },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ServiceSchema.index({ organization: 1, serviceName: 1 }, { unique: true });
ServiceSchema.index({ organization: 1, businessLine: 1, billingType: 1, status: 1 });

ServiceSchema.pre("validate", function normalizeTax(next) {
  if (!this.taxable) this.taxRate = 0;
  else if (this.taxRate === undefined || this.taxRate === null || Number.isNaN(Number(this.taxRate))) this.taxRate = 5;
  next();
});

module.exports = mongoose.model("Service", ServiceSchema);
module.exports.BILLING_TYPES = BILLING_TYPES;
module.exports.CURRENCIES = CURRENCIES;
