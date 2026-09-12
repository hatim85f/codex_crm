const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// One Shop & Ship (Aramex) box. Can carry items for multiple Shopify orders;
// linked Purchase docs point back here via `inboundShipment`.
//
// "At Destination" = arrived at the Aramex branch in Dubai, not yet handed
// over (Shop & Ship's own wording: "has arrived at the Aramex office at the
// destination and is being prepared for customer pickup/delivery"). This is
// distinct from "Delivered-to-office", which only applies once Shop & Ship's
// journey log says "Customer ID received" / "the shipment has been
// delivered" — those are the only two phrases that mean it's actually with us.
const STATUSES = ["At Origin", "In Transit", "At Customs", "At Destination", "Delivered-to-office"];

const InboundShipmentSchema = new Schema(
  {
    snsShipmentNumber: { type: String, required: true, unique: true, index: true },
    // Which courier this tracking number belongs to, so the sync job knows
    // which API to poll. "shopandship" (Aramex) has no public tracking API
    // yet (see syncAramexTracking) -- "dhl" polls DHL's Shipment Tracking API.
    carrier: { type: String, enum: ["shopandship", "dhl"], default: "shopandship" },
    seller: { type: String, default: "" }, // primary seller for this box, for quick reference
    weight: { type: Number, default: 0 },
    // Two separate legs of freight cost, kept as their own fields for an
    // honest audit trail (Shipito's consolidation/freight invoice is in USD;
    // the courier -- DHL today, Aramex/Shop & Ship historically -- bills the
    // last-mile/customs leg in AED). `feesAED` is auto-derived from both (see
    // pre-save hook below) and stays the single number every downstream
    // consumer (owner dashboard's per-item shipping cost, the Codex CRM
    // profit sync) already reads -- so both fees flow into both systems
    // without either one having to know this split exists.
    shipitoFeeUSD: { type: Number, default: 0 },
    courierFeeAED: { type: Number, default: 0 },
    feesAED: { type: Number, default: 0 }, // never exposed to employee dashboard — derived, don't set directly
    feesPaid: { type: Boolean, default: false }, // fees can be paid before customs is even reached — independent of `status`
    status: { type: String, enum: STATUSES, default: "At Origin", index: true },
    lastTrackingCheck: { type: Date, default: null },
    declaredGoodsNote: { type: String, default: "" }, // customs declared value ≠ real cost, never used for matching
    invoiceFiles: { type: [String], default: [] }, // Cloudinary URLs — Shipito/courier commercial invoice(s), mirrors Purchase.receiptFiles

    // Anchor dates for computing ETAs as absolute date ranges instead of a
    // relative day-count that goes stale the moment nobody rechecks it.
    // Stamped automatically (see routes/api/janmarini.js admin/shipments)
    // the first time each transition is observed — never overwritten once set.
    feesPaidDate: { type: Date, default: null },
    atDestinationDate: { type: Date, default: null },
    deliveredDate: { type: Date, default: null },

    // Set when Shop & Ship's journey log says something like "awaiting
    // further details from the customer" — a real blocker on OUR side, not
    // just time passing. Cleared once resolved. Shown as an action item on
    // the owner dashboard instead of any ETA.
    blockedReason: { type: String, default: "" },
  },
  { timestamps: true }
);

const AED_PER_USD = 3.8; // matches the CRM's own conversion constant (janmariniCrmSync.js)
function deriveFeesAED(courierFeeAED, shipitoFeeUSD) {
  return Math.round((Number(courierFeeAED || 0) + Number(shipitoFeeUSD || 0) * AED_PER_USD) * 100) / 100;
}

InboundShipmentSchema.pre("save", function (next) {
  if (this.isModified("shipitoFeeUSD") || this.isModified("courierFeeAED")) {
    this.feesAED = deriveFeesAED(this.courierFeeAED, this.shipitoFeeUSD);
  }
  next();
});

// findOneAndUpdate/findByIdAndUpdate bypass document middleware entirely --
// this is the query-level equivalent, needed because admin/shipments (and
// most of the ad-hoc scripts used to manage shipments so far) update this
// way rather than via .save().
InboundShipmentSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate() || {};
  const touchesFees = "shipitoFeeUSD" in update || "courierFeeAED" in update;
  if (!touchesFees) return next();
  const existing = await this.model.findOne(this.getQuery()).select("shipitoFeeUSD courierFeeAED").lean();
  const shipitoFeeUSD = "shipitoFeeUSD" in update ? update.shipitoFeeUSD : existing?.shipitoFeeUSD;
  const courierFeeAED = "courierFeeAED" in update ? update.courierFeeAED : existing?.courierFeeAED;
  update.feesAED = deriveFeesAED(courierFeeAED, shipitoFeeUSD);
  next();
});

InboundShipmentSchema.statics.STATUSES = STATUSES;

module.exports = conn.model("InboundShipment", InboundShipmentSchema);
