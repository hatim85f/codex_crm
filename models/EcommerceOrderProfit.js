const mongoose = require("mongoose");
const { BUSINESS_LINES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const FileSchema = new Schema(
  { fileName: { type: String, default: "" }, fileUrl: { type: String, required: true } },
  { _id: false }
);

const ProductSchema = new Schema(
  { name: { type: String, default: "" }, quantity: { type: Number, default: 1 }, cost: { type: Number, default: 0 } }, // cost = unit cost
  { _id: false }
);

// One batch buys for several customer orders at once (shipping/handling/fees are
// shared and allocated per order by revenue). Each order keeps its OWN number,
// date, products, amount paid and invoice — and its OWN computed profit margin.
const OrderLineSchema = new Schema(
  {
    orderNumber: { type: String, default: "" },
    orderDate: { type: Date, default: null },
    customerPaidAmount: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    aedAmount: { type: Number, default: 0 }, // revenue in AED for this order
    sellerTracking: { type: String, default: "" }, // vendor/seller tracking (eBay, etc.)
    aramexTracking: { type: String, default: "" }, // Aramex / Shop & Ship last-mile tracking
    products: { type: [ProductSchema], default: [] },
    customerInvoiceFiles: { type: [FileSchema], default: [] },
    // Computed per order
    productCost: { type: Number, default: 0 },
    allocatedCost: { type: Number, default: 0 }, // share of shipping/handling
    feeCost: { type: Number, default: 0 }, // gateway+shopify on this order
    totalCost: { type: Number, default: 0 },
    profit: { type: Number, default: 0 },
    margin: { type: Number, default: 0 }, // %
  },
  { _id: false }
);

// A free-form shared cost line (employee salary, packing materials, etc.).
const ExpenseLineSchema = new Schema(
  { label: { type: String, default: "" }, amount: { type: Number, default: 0 } },
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
    productBuyingCost: { type: Number, default: 0 }, // computed = sum of every order's product costs
    shippingCost: { type: Number, default: 0 }, // vendor shipping (any method)
    courierDeliveryCost: { type: Number, default: 0 }, // last-mile to customer
    packingHandlingCost: { type: Number, default: 0 }, // legacy single field (kept for old records)
    // Free-form shared expenses entered manually (employee salary, packing, etc.).
    extraExpenses: { type: [ExpenseLineSchema], default: [] },

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

const pct1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

EcommerceOrderProfitSchema.pre("save", function computeProfit(next) {
  const orders = this.orders || [];
  const totalRevenue = round(orders.reduce((s, o) => s + (Number(o.aedAmount) || 0), 0));
  const extraExpensesTotal = (this.extraExpenses || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const shared = (Number(this.shippingCost) || 0) + (Number(this.courierDeliveryCost) || 0) + (Number(this.packingHandlingCost) || 0) + extraExpensesTotal;
  const feePct = (Number(this.paymentGatewayFeePct) || 0) + (Number(this.shopifyFeePct) || 0);

  // Batch date = earliest order date.
  const dates = orders.map((o) => o.orderDate).filter(Boolean).map((d) => new Date(d).getTime());
  if (dates.length) this.orderDate = new Date(Math.min(...dates));

  // Per-order profit (shipping/handling allocated by revenue share, fees = % of order revenue).
  orders.forEach((o) => {
    const rev = Number(o.aedAmount) || 0;
    o.productCost = round((o.products || []).reduce((s, p) => s + (Number(p.quantity) || 1) * (Number(p.cost) || 0), 0));
    o.allocatedCost = round(totalRevenue > 0 ? shared * (rev / totalRevenue) : (orders.length ? shared / orders.length : 0));
    o.feeCost = round(rev * feePct / 100);
    o.totalCost = round(o.productCost + o.allocatedCost + o.feeCost);
    o.profit = round(rev - o.totalCost);
    o.margin = rev > 0 ? pct1((o.profit / rev) * 100) : 0;
  });

  this.aedAmount = totalRevenue;
  this.customerPaidAmount = round(orders.reduce((s, o) => s + (Number(o.customerPaidAmount) || 0), 0));
  this.productBuyingCost = round(orders.reduce((s, o) => s + o.productCost, 0));
  this.paymentGatewayFee = round(totalRevenue * (Number(this.paymentGatewayFeePct) || 0) / 100);
  this.shopifyFee = round(totalRevenue * (Number(this.shopifyFeePct) || 0) / 100);
  const costs = this.productBuyingCost + shared + this.paymentGatewayFee + this.shopifyFee;
  this.totalCost = round(costs);
  this.netProfit = round(totalRevenue - costs);
  this.profitMargin = totalRevenue > 0 ? pct1((this.netProfit / totalRevenue) * 100) : 0;
  next();
});

EcommerceOrderProfitSchema.index({ organization: 1, orderDate: -1 });

module.exports = mongoose.model("EcommerceOrderProfit", EcommerceOrderProfitSchema);
