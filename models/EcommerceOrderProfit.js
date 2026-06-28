const mongoose = require("mongoose");
const { BUSINESS_LINES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  { fileName: { type: String, default: "" }, fileUrl: { type: String, required: true }, fileType: { type: String, default: "" } },
  { _id: false }
);

const EcommerceOrderProfitSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    storeName: { type: String, required: true, trim: true },
    orderNumber: { type: String, default: "" },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "own_ecommerce_dropshipping", index: true },

    // Revenue
    customerPaidAmount: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    aedAmount: { type: Number, default: 0 }, // revenue in AED, manually entered

    // Costs
    productBuyingCost: { type: Number, default: 0 },
    vendorSource: { type: String, default: "" },
    stripeFee: { type: Number, default: 0 },
    shopifyFee: { type: Number, default: 0 },
    shopAndShipCost: { type: Number, default: 0 },
    courierDeliveryCost: { type: Number, default: 0 },
    packingHandlingCost: { type: Number, default: 0 },
    employeeHandlingAllocation: { type: Number, default: 0 },

    // Computed (set on save)
    totalCost: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 },
    profitMargin: { type: Number, default: 0 }, // %

    orderDate: { type: Date, default: Date.now, index: true },
    attachments: { type: [AttachmentSchema], default: [] },
    notes: { type: String, default: "" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Keep totals/margin consistent with the inputs.
EcommerceOrderProfitSchema.pre("save", function computeProfit(next) {
  const costs = [
    this.productBuyingCost, this.stripeFee, this.shopifyFee, this.shopAndShipCost,
    this.courierDeliveryCost, this.packingHandlingCost, this.employeeHandlingAllocation,
  ].reduce((s, n) => s + (Number(n) || 0), 0);
  const revenue = Number(this.aedAmount) || 0;
  this.totalCost = Math.round(costs * 100) / 100;
  this.netProfit = Math.round((revenue - costs) * 100) / 100;
  this.profitMargin = revenue > 0 ? Math.round((this.netProfit / revenue) * 1000) / 10 : 0;
  next();
});

EcommerceOrderProfitSchema.index({ organization: 1, orderDate: -1 });

module.exports = mongoose.model("EcommerceOrderProfit", EcommerceOrderProfitSchema);
