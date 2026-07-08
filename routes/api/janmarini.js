// Janmarini Fulfillment API — two audiences on one router:
//   1. Employee dashboard (PIN login + read-only order view, NO cost/profit data)
//   2. Admin/agent endpoints (static key) used by the daily sync + the Claude
//      review pass to write matched Purchases/Shipments back.
// Deliberately separate from Codex CRM's own auth (JWT secret + login flow) so
// the employee can never reach CRM data even if her token leaked.
const express = require("express");
const jwt = require("jsonwebtoken");

const router = express.Router();

const ShopifyOrder = require("../../models/janmarini/ShopifyOrder");
const Purchase = require("../../models/janmarini/Purchase");
const InboundShipment = require("../../models/janmarini/InboundShipment");
const PendingReceipt = require("../../models/janmarini/PendingReceipt");
const { runDailySync } = require("../../services/janmariniSync");
const { fulfillShopifyOrder } = require("../../services/shopifyFulfillment");
const { confirmPendingReceipt, rejectPendingReceipt } = require("../../services/janmariniReceiptParser");

const getEmployeeSecret = () => process.env.JANMARINI_JWT_SECRET || "janmarini-dev-secret-change-me";

// Matches Codex CRM's own EcommerceOrderProfit accounting convention (fixed
// for now, per Hatim) — same 3% payment gateway + 2.9% Shopify fee on
// revenue, plus a flat AED 30/order last-mile delivery cost, so the owner
// dashboard's profit figure lines up with CRM instead of understating cost.
const PAYMENT_GATEWAY_FEE_PCT = 3;
const SHOPIFY_FEE_PCT = 2.9;
const DELIVERY_FEE_AED = 30;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- Employee auth ---------------------------------------------------------

function employeeAuth(req, res, next) {
  const token = req.header("x-auth-token");
  if (!token) return res.status(401).json({ message: "No token, authorization denied" });
  try {
    jwt.verify(token, getEmployeeSecret());
    next();
  } catch (e) {
    return res.status(401).json({ message: "Token is not valid" });
  }
}

router.post("/login", (req, res) => {
  const { pin } = req.body || {};
  const expectedPin = process.env.JANMARINI_EMPLOYEE_PIN;
  if (!expectedPin) return res.status(500).json({ message: "Server not configured: JANMARINI_EMPLOYEE_PIN missing" });
  if (!pin || String(pin) !== String(expectedPin)) {
    return res.status(401).json({ message: "Incorrect PIN" });
  }
  const token = jwt.sign({ role: "janmarini_employee" }, getEmployeeSecret(), { expiresIn: "30d" });
  res.json({ token });
});

// Owner (Hatim) login — separate PIN, separate role claim, same JWT secret.
// Unlocks the full-detail dashboard (all 7 stages + costs/fees), which the
// employee must never see.
router.post("/owner/login", (req, res) => {
  const { pin } = req.body || {};
  const expectedPin = process.env.JANMARINI_OWNER_PIN;
  if (!expectedPin) return res.status(500).json({ message: "Server not configured: JANMARINI_OWNER_PIN missing" });
  if (!pin || String(pin) !== String(expectedPin)) {
    return res.status(401).json({ message: "Incorrect PIN" });
  }
  const token = jwt.sign({ role: "janmarini_owner" }, getEmployeeSecret(), { expiresIn: "30d" });
  res.json({ token });
});

function ownerAuth(req, res, next) {
  const token = req.header("x-auth-token");
  if (!token) return res.status(401).json({ message: "No token, authorization denied" });
  try {
    const decoded = jwt.verify(token, getEmployeeSecret());
    if (decoded.role !== "janmarini_owner") return res.status(403).json({ message: "Forbidden" });
    next();
  } catch (e) {
    return res.status(401).json({ message: "Token is not valid" });
  }
}

// Full per-item status, including stages the employee never sees (shipped by
// seller / at Shop & Ship / fees paid / at destination). Ordered most- to
// least-advanced — "fees paid" and "at destination" are independent signals
// (fees can be paid before the parcel even reaches customs), so priority
// matters here, not just a straight status lookup.
function rawStatus(purchase) {
  if (purchase.status === "delivered") return "delivered";
  const shipment = purchase.inboundShipment;
  if (!shipment) return purchase.status; // "ordered" | "shipped_by_seller"
  if (shipment.status === "Delivered-to-office") return "in_office";
  if (shipment.status === "At Destination") return "at_destination";
  if (shipment.feesPaid) return "fees_paid";
  if (shipment.status === "At Origin") return "at_shop_and_ship";
  return "in_transit_to_dubai"; // In Transit / At Customs
}

// Collapses the raw status into what the employee dashboard shows — she
// doesn't need to know about seller shipping / Shop & Ship / fee payment /
// destination-branch arrival, just whether it's still "out there somewhere"
// or actively on its way.
function displayStatus(purchase) {
  const raw = rawStatus(purchase);
  if (raw === "shipped_by_seller" || raw === "at_shop_and_ship" || raw === "fees_paid") return "ordered";
  if (raw === "at_destination") return "in_transit_to_dubai";
  return raw;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
// Absolute date ranges computed from a fixed anchor (purchase date / the date
// fees were paid / the date it reached the destination branch) instead of a
// relative "X days" countdown — self-corrects as time passes with no
// background job needed to keep it from going stale.
//
// Shop & Ship's own wording (for when parsing future screenshots/emails):
//   "At Destination"                     -> arrived in Dubai, NOT yet picked
//                                            up (our "At Destination" status)
//   "Customer ID received" / "Collected" -> actually delivered to us
//                                            (our "Delivered-to-office")
//   "awaiting further details from the customer" -> genuinely blocked on us,
//                                            not just time passing — see
//                                            InboundShipment.blockedReason
// `forOwner` controls whether a blocked shipment's specific reason is shown —
// she can't act on "awaiting customs details" anyway (only Hatim can respond
// to Aramex), so she gets a generic "delayed" note instead of either the
// actionable detail or a blank/missing-looking gap.
function etaNote(purchase, forOwner = false) {
  if (purchase.status === "delivered") return null;
  const shipment = purchase.inboundShipment;
  if (shipment?.status === "Delivered-to-office") return null;
  if (shipment?.blockedReason) {
    return forOwner ? `Action needed: ${shipment.blockedReason}` : "Delayed — being resolved";
  }

  if (shipment?.status === "At Destination") {
    const anchor = shipment.atDestinationDate || shipment.lastTrackingCheck || new Date();
    return `Expected around ${formatDate(addDays(anchor, 2))}`;
  }
  if (shipment?.feesPaid) {
    const anchor = shipment.feesPaidDate || shipment.lastTrackingCheck || new Date();
    return `Expected around ${formatDate(addDays(anchor, 4))}`;
  }
  const anchor = purchase.purchaseDate || purchase.createdAt || new Date();
  return `Expected ${formatDate(addDays(anchor, 10))} - ${formatDate(addDays(anchor, 12))}`;
}

router.get("/orders", employeeAuth, async (req, res) => {
  try {
    const orders = await ShopifyOrder.find({ ignored: false }).sort({ orderDate: -1 }).lean();
    const purchases = await Purchase.find({ orderNumber: { $in: orders.map((o) => o.orderNumber) } })
      .populate("inboundShipment", "status snsShipmentNumber feesPaid feesPaidDate atDestinationDate blockedReason lastTrackingCheck")
      .lean();

    const byOrderNumber = new Map();
    for (const p of purchases) {
      if (!byOrderNumber.has(p.orderNumber)) byOrderNumber.set(p.orderNumber, []);
      byOrderNumber.get(p.orderNumber).push(p);
    }

    const view = orders.map((o) => ({
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      orderDate: o.orderDate,
      totalPrice: o.totalPrice,
      currency: o.currency,
      fulfilled: !!o.fulfilled,
      items: o.items.map((item) => {
        const match = (byOrderNumber.get(o.orderNumber) || []).find(
          (p) => p.itemName.toLowerCase() === item.name.toLowerCase()
        );
        return {
          name: item.name,
          quantity: item.quantity,
          image: item.image,
          status: match ? displayStatus(match) : "ordered",
          aramexTracking: match?.inboundShipment?.snsShipmentNumber || null,
          etaNote: match
            ? etaNote(match)
            : `Expected ${formatDate(addDays(o.orderDate || new Date(), 10))} - ${formatDate(addDays(o.orderDate || new Date(), 12))}`,
        };
      }),
    }));

    res.json(view);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Owner's full-detail view — every item, every stage, plus cost/fee data the
// employee dashboard deliberately hides.
router.get("/owner/orders", ownerAuth, async (req, res) => {
  try {
    const orders = await ShopifyOrder.find({ ignored: false }).sort({ orderDate: -1 }).lean();
    const purchases = await Purchase.find({ orderNumber: { $in: orders.map((o) => o.orderNumber) } })
      .populate("inboundShipment", "status snsShipmentNumber feesAED feesPaid feesPaidDate atDestinationDate blockedReason lastTrackingCheck")
      .lean();

    const byOrderNumber = new Map();
    for (const p of purchases) {
      if (!byOrderNumber.has(p.orderNumber)) byOrderNumber.set(p.orderNumber, []);
      byOrderNumber.get(p.orderNumber).push(p);
    }

    const view = orders.map((o) => {
      const items = o.items.map((item) => {
        const match = (byOrderNumber.get(o.orderNumber) || []).find(
          (p) => p.itemName.toLowerCase() === item.name.toLowerCase()
        );
        return {
          name: item.name,
          quantity: item.quantity,
          image: item.image,
          status: match ? rawStatus(match) : "ordered",
          seller: match?.seller || "",
          ebayOrderNumber: match?.ebayOrderNumber || "",
          costUSD: match?.costUSD || 0,
          costAED: match?.costUSD ? Math.round(match.costUSD * 3.8 * 100) / 100 : 0,
          aramexTracking: match?.inboundShipment?.snsShipmentNumber || null,
          shippingFeesAED: match?.inboundShipment?.feesAED || 0,
          feesPaid: !!match?.inboundShipment?.feesPaid,
          blockedReason: match?.inboundShipment?.blockedReason || "",
          flagNote: match?.flagNote || "",
          etaNote: match ? etaNote(match, true) : `Expected ${formatDate(addDays(o.orderDate || new Date(), 10))} - ${formatDate(addDays(o.orderDate || new Date(), 12))}`,
        };
      });

      const revenue = Number(o.totalPrice) || 0;
      const totalCostAED = round2(items.reduce((s, i) => s + (i.costAED || 0), 0));
      const totalShippingFeesAED = round2(items.reduce((s, i) => s + (i.shippingFeesAED || 0), 0));
      const paymentGatewayFeeAED = round2(revenue * (PAYMENT_GATEWAY_FEE_PCT / 100));
      const shopifyFeeAED = round2(revenue * (SHOPIFY_FEE_PCT / 100));
      const deliveryFeeAED = DELIVERY_FEE_AED;
      const profit = round2(
        revenue - totalCostAED - totalShippingFeesAED - paymentGatewayFeeAED - shopifyFeeAED - deliveryFeeAED
      );

      return {
        orderNumber: o.orderNumber,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        orderDate: o.orderDate,
        totalPrice: o.totalPrice,
        currency: o.currency,
        fulfilled: !!o.fulfilled,
        totalCostAED,
        totalShippingFeesAED,
        paymentGatewayFeeAED,
        shopifyFeeAED,
        deliveryFeeAED,
        profit,
        items,
      };
    });

    res.json(view);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// AI-parsed suggestions awaiting a human tap before anything gets written to
// Purchase/InboundShipment — see services/janmariniReceiptParser.js. Owner
// dashboard only; the employee never sees cost/purchase data.
router.get("/owner/pending-receipts", ownerAuth, async (req, res) => {
  try {
    const items = await PendingReceipt.find({ status: "awaiting_confirmation" }).sort({ createdAt: -1 }).lean();
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post("/owner/pending-receipts/:id/confirm", ownerAuth, async (req, res) => {
  try {
    const { receipt, applied, skipped, total } = await confirmPendingReceipt(req.params.id);
    res.json({ ...receipt.toObject(), applied, skipped, total });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

router.post("/owner/pending-receipts/:id/reject", ownerAuth, async (req, res) => {
  try {
    const doc = await rejectPendingReceipt(req.params.id);
    res.json(doc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// Employee marks an order as packed/handed over. Fulfills it in Shopify too
// (so both systems agree), attaching Aramex tracking if we already have one.
router.post("/orders/:orderNumber/fulfill", employeeAuth, async (req, res) => {
  const orderNumber = decodeURIComponent(req.params.orderNumber);
  try {
    const order = await ShopifyOrder.findOne({ orderNumber });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const purchases = await Purchase.find({ orderNumber }).populate("inboundShipment", "snsShipmentNumber");
    const trackingNumber = purchases.find((p) => p.inboundShipment?.snsShipmentNumber)?.inboundShipment
      ?.snsShipmentNumber;

    await fulfillShopifyOrder(order.shopifyOrderId, trackingNumber);

    order.fulfilled = true;
    order.fulfilledAt = new Date();
    await order.save();
    await Purchase.updateMany({ orderNumber }, { status: "delivered" });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ---- Admin / agent endpoints ----------------------------------------------

function adminAuth(req, res, next) {
  const key = req.header("x-admin-key");
  if (!process.env.JANMARINI_ADMIN_KEY) return res.status(500).json({ message: "Server not configured: JANMARINI_ADMIN_KEY missing" });
  if (!key || key !== process.env.JANMARINI_ADMIN_KEY) return res.status(401).json({ message: "Invalid admin key" });
  next();
}

router.use("/admin", adminAuth);

// Manually trigger the same sync Heroku Scheduler runs daily (useful while testing).
router.post("/admin/sync", async (req, res) => {
  try {
    res.json(await runDailySync());
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get("/admin/pending-receipts", async (req, res) => {
  const status = req.query.status || "pending";
  res.json(await PendingReceipt.find({ status }).sort({ createdAt: -1 }).lean());
});

router.post("/admin/pending-receipts/:id/resolve", async (req, res) => {
  const { status, matchedPurchase } = req.body || {};
  const doc = await PendingReceipt.findByIdAndUpdate(
    req.params.id,
    { status: status || "processed", matchedPurchase: matchedPurchase || null },
    { new: true }
  );
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json(doc);
});

router.post("/admin/purchases", async (req, res) => {
  try {
    const doc = await Purchase.create(req.body);
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

router.patch("/admin/purchases/:id", async (req, res) => {
  const doc = await Purchase.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json(doc);
});

// Auto-stamps the anchor dates the first time each transition is observed —
// this is the ONE place these get set, so ETA math never needs a background
// job to stay accurate; it just reads whatever was stamped here.
router.post("/admin/shipments", async (req, res) => {
  try {
    const existing = await InboundShipment.findOne({ snsShipmentNumber: req.body.snsShipmentNumber });
    const update = { ...req.body };
    const now = new Date();

    if (update.feesPaid && !existing?.feesPaidDate) update.feesPaidDate = now;
    if (update.status === "At Destination" && !existing?.atDestinationDate) update.atDestinationDate = now;
    if (update.status === "Delivered-to-office" && !existing?.deliveredDate) update.deliveredDate = now;

    const doc = await InboundShipment.findOneAndUpdate(
      { snsShipmentNumber: req.body.snsShipmentNumber },
      update,
      { upsert: true, new: true }
    );
    res.status(201).json(doc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

module.exports = router;
