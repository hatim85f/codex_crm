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
    orderNumber: { type: String, default: "", index: true }, // Shopify order this item is for, e.g. "#1750" — blank for unassigned stock
    itemName: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1 },

    ebayOrderNumber: { type: String, default: "" },
    // eBay's own listing id (the number in parentheses on the bill, e.g.
    // "(407165878999)") -- unique per item, unlike ebayOrderNumber which can
    // cover several items in one checkout. eBay's "shipped"/"order update"
    // notification emails carry this same id in their tracking links, so
    // it's the join key the shipped-email watcher uses (see
    // services/ebayShippedWatcher.js) -- those emails never contain a
    // plaintext seller tracking number, only this id.
    ebayItemId: { type: String, default: "", index: true },
    // The raw eBay listing title as extracted from the purchase bill (e.g.
    // "Jan Marini C-Esta Face Serum 1 oz - Exp 07/27 Brand New in Box") --
    // kept separately from itemName because itemName gets overwritten with
    // the Shopify order's own catalog name once assigned (e.g. "C-ESTA®
    // Face Serum"). Some seller shipping-notification emails only carry an
    // item name and a tracking number, no eBay item ID -- this is what
    // ebayShippedWatcher.js matches those against, since the order's catalog
    // name is worded too differently from the seller's own listing title to
    // match reliably.
    ebayListingName: { type: String, default: "" },
    seller: { type: String, default: "" },
    costUSD: { type: Number, default: 0 }, // never exposed to employee dashboard
    sellerTracking: { type: String, default: "" }, // USPS/seller tracking, active before Shop & Ship pickup

    inboundShipment: { type: Schema.Types.ObjectId, ref: "InboundShipment", default: null },
    status: { type: String, enum: STATUSES, default: "ordered", index: true },

    purchaseDate: { type: Date, default: null },
    receiptFiles: { type: [String], default: [] }, // Cloudinary URLs (audit trail, mirrors Codex CRM)
    flagNote: { type: String, default: "" }, // e.g. "ordered Retinol Plus, receipt shows Peptide Extreme"

    // Unassigned inventory — an item that's been bought but isn't (or is no
    // longer) tied to a live order, e.g. leftover goods from a cancelled
    // order, or something the fulfillment team logged by hand. Kept as a flag
    // on the same Purchase model rather than a separate collection so it
    // reuses status/cost/tracking instead of duplicating them.
    isStock: { type: Boolean, default: false, index: true },
    stockNote: { type: String, default: "" }, // e.g. "from cancelled order #1754"
    shopAndShipTracking: { type: String, default: "" }, // lightweight tracking # for stock items with no full InboundShipment record yet

    // Shipito for Business API linkage -- set once we register this package
    // with Shipito via createPackage (needs a real sellerTracking first, see
    // services/shipitoApi.js). Lets syncShipitoStatus() poll this specific
    // package's status/tracking without re-registering it every run.
    shipitoReferenceNumber: { type: String, default: "", index: true },
    shipitoPackageId: { type: String, default: "" }, // Shipito's own letter-code package ID, for cross-checking on their website
  },
  { timestamps: true }
);

PurchaseSchema.statics.STATUSES = STATUSES;

module.exports = conn.model("Purchase", PurchaseSchema);
