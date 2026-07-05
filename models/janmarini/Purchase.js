const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// One eBay purchase line = one item bought to fulfill (part of) one Shopify order.
// Status starts here (ordered / shipped_by_seller) and is later driven by the
// linked InboundShipment once it gets a Shop & Ship shipment number.
const STATUSES = [
  "ordered",
  "shipped_by_seller",
  "at_shop_and_ship",
  "in_transit_to_dubai",
  "in_office",
  "delivered",
];

const PurchaseSchema = new Schema(
  {
    orderNumber: { type: String, required: true, index: true }, // Shopify order this item is for, e.g. "#1750"
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1 },

    ebayOrderNumber: { type: String, default: "" },
    seller: { type: String, default: "" },
    costUSD: { type: Number, default: 0 }, // never exposed to employee dashboard
    sellerTracking: { type: String, default: "" }, // USPS/seller tracking, active before Shop & Ship pickup

    inboundShipment: { type: Schema.Types.ObjectId, ref: "InboundShipment", default: null },
    status: { type: String, enum: STATUSES, default: "ordered", index: true },

    purchaseDate: { type: Date, default: null },
    receiptFiles: { type: [String], default: [] }, // Cloudinary URLs (audit trail, mirrors Codex CRM)
    flagNote: { type: String, default: "" }, // e.g. "ordered Retinol Plus, receipt shows Peptide Extreme"
  },
  { timestamps: true }
);

PurchaseSchema.statics.STATUSES = STATUSES;

module.exports = conn.model("Purchase", PurchaseSchema);
