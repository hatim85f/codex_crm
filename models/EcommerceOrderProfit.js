const mongoose = require("mongoose");
const { BUSINESS_LINES } = require("../services/accountingConstants");

const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  { fileName: { type: String, default: "" }, fileUrl: { type: String, required: true }, fileType: { type: String, default: "" } },
  { _id: false }
);

// An order can contain several products (we buy in bulk for many orders at once),
// so the buying cost is the sum of all product lines = the order cost.
const ProductSchema = new Schema(
  { name: { type: String, default: "" }, quantity: { type: Number, default: 1 }, cost: { type: Number, default: 0 } }, // cost = unit cost
  { _id: false }
);

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

const EcommerceOrderProfitSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    storeName: { type: String, required: true, trim: true },
    orderNumber: { type: String, default: "" },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "own_ecommerce_dropshipping", index: true },
    vendorSource: { type: String, default: "" },

    // Revenue
    customerPaidAmount: { type: Number, default: 0 },
    currency: { type: String, default: "AED" },
    aedAmount: { type: Number, default: 0 }, // revenue in AED, manually entered

    // Costs
    products: { type: [ProductSchema], default: [] },
    productBuyingCost: { type: Number, default: 0 }, // computed = sum of product lines (= order cost)
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
    attachments: { type: [AttachmentSchema], default: [] },
    notes: { type: String, default: "" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

EcommerceOrderProfitSchema.pre("save", function computeProfit(next) {
  const revenue = Number(this.aedAmount) || 0;
  this.productBuyingCost = round((this.products || []).reduce((s, p) => s + (Number(p.quantity) || 0) * (Number(p.cost) || 0), 0));
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
