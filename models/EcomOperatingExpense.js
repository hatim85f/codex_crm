const mongoose = require("mongoose");

const { Schema } = mongoose;

// A monthly operating cost (employee salary, rent, tools, etc.) entered once for
// a month and divided equally across that month's eCommerce orders.
const EcomOperatingExpenseSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    periodYear: { type: Number, required: true },
    periodMonth: { type: Number, required: true, min: 1, max: 12 }, // 1-12
    label: { type: String, required: true, trim: true },
    amount: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

EcomOperatingExpenseSchema.index({ organization: 1, periodYear: 1, periodMonth: 1 });

module.exports = mongoose.model("EcomOperatingExpense", EcomOperatingExpenseSchema);
