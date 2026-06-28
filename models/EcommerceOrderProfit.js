const mongoose = require("mongoose");
const { BUSINESS_LINES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const FileSchema = new Schema(
  { fileName: { type: String, default: "" }, fileUrl: { type: String, required: true } },
  { _id: false }
);

// One batch buys for several customer orders at once (so shipping/handling/fees
// are shared). Each order keeps its OWN number, amount paid and invoice files —
// so income analysis stays per-order with no conflict.
const OrderLineSchema = new Schema(
  {
    orderNumber: { type: String, default: "" },
    customerPaidAmount: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    aedAmount: { type: Number, default: 0 }, // revenue in AED for this order
    customerInvoiceFiles: { type: [FileSchema], default: [] },
  },
  { _id: false }
);

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const EcommerceOrderProfitSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    storeName: { type: String, required: true, trim: true },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "own_ecommerce_dropshipping", index: true },
    vendorSource: { type: String, default: "" },

    // Customer orders in this batch (each keeps its own number + invoices).
    orders: { type: [OrderLineSchema], default: [] },
    // Revenue totals (computed from orders[]).
    customerPaidAmount: { type: Number, default: 0 },
    aedAmount: { type: Number, default: 0 }, // total revenue in AED

    // Shared costs for the whole batch
    productBuyingCost: { type: Number, default: 0 }, // goods cost (one bill for all orders)
    shippingCost: { type: Number, default: 0 }, // vendor shipping (any method)
    courierDeliveryCost: { type: Number, default: 0 }, // last-mile to customer
    packingHandlingCost: { type: Number, default: 0 },

    // Percentage fees of revenue
    paymentGatewayFeePct: { type: Number, default: 0 }, // % of revenue
    shopifyFeePct: { type: Number, default: 0 }, // % of revenue
    paymentGatewayFee: { type: Number, default: 0 }, // computed AED
    shopifyFee: { type: Number, default: 0 }, // computed AED

    // Computed (set on save)
    totalCost: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 },
    profitMargin: { type: Number, default: 0 }, // %

    orderDate: { type: Date, default: Date.now, index: true },
    // Shared goods purchase receipt(s) for the whole batch (customer invoices live per-order).
    goodsReceiptFiles: { type: [FileSchema], default: [] },
    notes: { type: String, default: "" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

EcommerceOrderProfitSchema.pre("save", function computeProfit(next) {
  const orders = this.orders || [];
  this.aedAmount = round(orders.reduce((s, o) => s + (Number(o.aedAmount) || 0), 0));
  this.customerPaidAmount = round(orders.reduce((s, o) => s + (Number(o.customerPaidAmount) || 0), 0));
  const revenue = this.aedAmount;
  this.paymentGatewayFee = round(revenue * (Number(this.paymentGatewayFeePct) || 0) / 100);
  this.shopifyFee = round(revenue * (Number(this.shopifyFeePct) || 0) / 100);
  const costs = this.productBuyingCost
    + (Number(this.shippingCost) || 0) + (Number(this.courierDeliveryCost) || 0)
    + (Number(this.packingHandlingCost) || 0) + this.paymentGatewayFee + this.shopifyFee;
  this.totalCost = round(costs);
  this.netProfit = round(revenue - costs);
  this.profitMargin = revenue > 0 ? Math.round((this.netProfit / revenue) * 1000) / 10 : 0;
  next();
});

EcommerceOrderProfitSchema.index({ organization: 1, orderDate: -1 });

module.exports = mongoose.model("EcommerceOrderProfit", EcommerceOrderProfitSchema);
