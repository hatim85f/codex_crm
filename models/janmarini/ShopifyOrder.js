const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

const ItemSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1 },
    image: { type: String, default: "" },
    price: { type: Number, default: 0 }, // customer-facing unit price (not cost) — fine for employee view
  },
  { _id: false }
);

const AddressSchema = new Schema(
  {
    address1: { type: String, default: "" },
    address2: { type: String, default: "" },
    city: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { _id: false }
);

const ShopifyOrderSchema = new Schema(
  {
    shopifyOrderId: { type: String, required: true, unique: true, index: true }, // Shopify GID or numeric id
    orderNumber: { type: String, required: true, index: true }, // e.g. "#1750"
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    shippingAddress: { type: AddressSchema, default: () => ({}) },
    items: { type: [ItemSchema], default: [] },
    orderDate: { type: Date, default: null },
    totalPrice: { type: Number, default: 0 }, // order value from Shopify — helps the employee recognize the order
    currency: { type: String, default: "AED" },
    ignored: { type: Boolean, default: false }, // test/refunded orders (e.g. #1760-1762)
    fulfilled: { type: Boolean, default: false, index: true },
    fulfilledAt: { type: Date, default: null },
    // Customer-facing invoice, generated from this order data since Shopify's
    // native Order Printer app has no headless/API way to produce one (it's a
    // browser-only "print to PDF" action) — see janmariniInvoice.js.
    invoiceUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = conn.model("ShopifyOrder", ShopifyOrderSchema);
