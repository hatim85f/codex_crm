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
    seller: { type: String, default: "" }, // primary seller for this box, for quick reference
    weight: { type: Number, default: 0 },
    feesAED: { type: Number, default: 0 }, // never exposed to employee dashboard
    feesPaid: { type: Boolean, default: false }, // fees can be paid before customs is even reached — independent of `status`
    status: { type: String, enum: STATUSES, default: "At Origin", index: true },
    lastTrackingCheck: { type: Date, default: null },
    declaredGoodsNote: { type: String, default: "" }, // customs declared value ≠ real cost, never used for matching

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

InboundShipmentSchema.statics.STATUSES = STATUSES;

module.exports = conn.model("InboundShipment", InboundShipmentSchema);
