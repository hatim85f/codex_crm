// Mirrors confirmed Janmarini fulfillment data into Codex CRM's own
// EcommerceOrderProfit collection (default "test" DB connection — NOT the
// separate janmarini_fulfillment connection), so accounting has an audit
// trail without anyone re-typing numbers by hand.
//
// Batching key is `ebayOrderNumber`, not Shopify order number. Hatim buys
// items for several different Shopify orders in one eBay checkout — those
// Purchase records share the same ebayOrderNumber, the same bill, and
// usually the same Shop & Ship box. The historical hand-entered records
// already group orders this way (e.g. #1750+#1751 share eBay order
// "25-14780-25318" and one document) — this sync matches that convention
// instead of writing one document per Shopify order.
//
// Historical order numbers are stored inconsistently ("Order # 1750",
// "Order  #1757" with a double space, "#1754") — every comparison below is
// by DIGITS ONLY so a differently-formatted existing record can never be
// mistaken for a fresh order and duplicated.
//
// Records this sync itself created (notes === AUTO_SYNC_NOTE) are refreshed
// in place as new data comes in (e.g. a shipment fee becomes known after the
// box ships) — only records it did NOT create (the hand-entered historical
// batches) are ever left untouched.
//
// Fee methodology matches the CRM's own accounting convention (see the
// profit-discrepancy investigation): 3% payment gateway + 2.9% Shopify fee on
// revenue, plus a flat AED 30/order delivery cost (same figure the owner
// dashboard already shows). Employee salary, handling, rent, etc. are NOT
// modeled here — those are monthly totals, not per-order costs, and the CRM
// already has a mechanism for that: EcomOperatingExpense entries (entered
// once a month via the Accounting module) get divided equally across every
// eCommerce order that month via opexAllocation.recalcForBatch, which this
// sync calls after every write so Janmarini orders participate in that
// allocation automatically, same as any other business line.
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const Purchase = require("../models/janmarini/Purchase");
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");
const { ensureOrderInvoice } = require("./janmariniInvoice");
const { recalcForBatch } = require("./opexAllocation");

const ORGANIZATION_ID = "6a308a0ff2cebbca8453bc2c"; // Codex FZE Technology
const STORE_NAME = "Janmarini";
const AUTO_SYNC_NOTE = "Auto-synced by Janmarini Tracking automation";
const PAYMENT_GATEWAY_FEE_PCT = 3;
const SHOPIFY_FEE_PCT = 2.9;
const AED_PER_USD = 3.8;
const DELIVERY_FEE_AED = 30; // per order — matches the owner dashboard's flat delivery cost

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digitsOnly = (s) => (s || "").replace(/\D/g, "").replace(/^0+/, "");

async function buildOrderLine(order, itemsForOrder, dryRun) {
  const products = itemsForOrder.map((p) => ({
    name: p.itemName,
    quantity: p.quantity || 1,
    cost: round((p.costUSD * AED_PER_USD) / (p.quantity || 1)), // schema expects unit cost
  }));
  const aramexTracking = [...new Set(itemsForOrder.map((p) => p.inboundShipment?.snsShipmentNumber).filter(Boolean))].join(", ");
  const sellerTracking = [...new Set(itemsForOrder.map((p) => p.sellerTracking).filter(Boolean))].join(", ");
  const revenue = Number(order.totalPrice) || 0;

  // ensureOrderInvoice uploads a real file and writes to the DB — never call
  // it during a dry run, which must have zero side effects.
  let customerInvoiceFiles = [];
  if (dryRun) {
    customerInvoiceFiles = order.invoiceUrl
      ? [{ fileName: `Invoice ${order.orderNumber}`, fileUrl: order.invoiceUrl }]
      : [{ fileName: `Invoice ${order.orderNumber}`, fileUrl: "(would be generated)" }];
  } else {
    try {
      const invoiceUrl = await ensureOrderInvoice(order);
      customerInvoiceFiles = [{ fileName: `Invoice ${order.orderNumber}`, fileUrl: invoiceUrl }];
    } catch (e) {
      console.warn(`[janmarini] Could not generate invoice for ${order.orderNumber}: ${e.message}`);
    }
  }

  return {
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    customerPaidAmount: revenue,
    currency: order.currency || "AED",
    aedAmount: revenue, // store currency is AED — no conversion needed
    sellerTracking,
    aramexTracking,
    products,
    customerInvoiceFiles,
  };
}

// Rebuilds a doc's orders[] + shared costs FULLY FRESH from every costed
// Purchase currently on record for the given order numbers — not just the
// purchases in whatever batch triggered this update. This is what makes
// re-syncing idempotent and safe even when a single order accumulates items
// from more than one source over time (e.g. one item bought on eBay in a
// checkout batch, another added later from existing stock with no eBay
// purchase at all) — the earlier version only wrote the current batch's
// items and silently wiped out anything from a prior batch sharing the doc.
async function rebuildDocContents(orderNumbers, orderByNumber, dryRun) {
  const purchases = await Purchase.find({ orderNumber: { $in: orderNumbers }, costUSD: { $gt: 0 } })
    .populate("inboundShipment", "snsShipmentNumber feesAED")
    .lean();

  const shopifyOrdersInSet = orderNumbers.map((n) => orderByNumber.get(n)).filter(Boolean);
  const orderLines = await Promise.all(
    shopifyOrdersInSet.map((order) =>
      buildOrderLine(order, purchases.filter((p) => p.orderNumber === order.orderNumber), dryRun)
    )
  );

  const shipmentIds = new Set();
  let shippingCost = 0;
  for (const p of purchases) {
    if (p.inboundShipment && !shipmentIds.has(String(p.inboundShipment._id))) {
      shipmentIds.add(String(p.inboundShipment._id));
      shippingCost += Number(p.inboundShipment.feesAED) || 0;
    }
  }
  const goodsReceiptFiles = [
    ...new Map(
      purchases.flatMap((p) => p.receiptFiles || []).map((url) => [url, { fileName: "", fileUrl: url }])
    ).values(),
  ];

  return {
    orders: orderLines,
    shippingCost: round(shippingCost),
    courierDeliveryCost: round(DELIVERY_FEE_AED * orderLines.length),
    paymentGatewayFeePct: PAYMENT_GATEWAY_FEE_PCT,
    shopifyFeePct: SHOPIFY_FEE_PCT,
    goodsReceiptFiles,
  };
}

async function syncCrmProfitRecords({ dryRun = false } = {}) {
  const existingDocs = await EcommerceOrderProfit.find({ organization: ORGANIZATION_ID })
    .select("orders.orderNumber notes")
    .lean();
  const existingByDigits = new Map(); // digitsOnly(orderNumber) -> { docId, isAuto }
  const docOrderNumbers = new Map(); // docId -> Set of that doc's current order numbers (real, not digits-only)
  for (const doc of existingDocs) {
    for (const o of doc.orders || []) {
      existingByDigits.set(digitsOnly(o.orderNumber), { docId: doc._id, isAuto: doc.notes === AUTO_SYNC_NOTE });
      const key = String(doc._id);
      if (!docOrderNumbers.has(key)) docOrderNumbers.set(key, new Set());
      docOrderNumbers.get(key).add(o.orderNumber);
    }
  }

  const shopifyOrders = await ShopifyOrder.find({ ignored: false }).lean();
  const orderByNumber = new Map(shopifyOrders.map((o) => [o.orderNumber, o]));

  const purchases = await Purchase.find({ costUSD: { $gt: 0 } }).select("orderNumber ebayOrderNumber").lean();

  // Group into eBay-checkout batches. Purchases with no ebayOrderNumber yet
  // (in-stock items, or a data-entry gap) each become their own singleton
  // batch rather than being silently lumped together under one empty key.
  const batches = new Map();
  for (const p of purchases) {
    const key = p.ebayOrderNumber ? `ebay:${p.ebayOrderNumber}` : `solo:${p._id}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(p);
  }

  let created = 0;
  let updated = 0;
  let skippedHistorical = 0;
  let skippedAmbiguous = 0;
  let skippedNoShopifyOrder = 0;
  const preview = [];

  for (const [, batchPurchases] of batches) {
    const orderNumbers = [...new Set(batchPurchases.map((p) => p.orderNumber))];
    const covering = orderNumbers.map((n) => existingByDigits.get(digitsOnly(n))).filter(Boolean);

    if (covering.some((c) => !c.isAuto)) {
      skippedHistorical += 1; // at least one order in this batch has a hand-entered record — never touch
      continue;
    }

    const autoDocIds = new Set(covering.filter((c) => c.isAuto).map((c) => String(c.docId)));
    if (autoDocIds.size > 1) {
      skippedAmbiguous += 1; // batch composition spans more than one prior auto-synced doc — needs a human look
      continue;
    }

    if (orderNumbers.some((n) => !orderByNumber.has(n))) {
      skippedNoShopifyOrder += 1; // a purchase references a Shopify order we don't have (ignored/typo)
      continue;
    }

    let savedDoc = null;
    if (autoDocIds.size === 1) {
      const docId = [...autoDocIds][0];
      const fullOrderNumbers = [...new Set([...(docOrderNumbers.get(docId) || []), ...orderNumbers])];
      const fields = await rebuildDocContents(fullOrderNumbers, orderByNumber, dryRun);
      if (dryRun) {
        preview.push({ action: "update", docId, ...fields });
      } else {
        // findByIdAndUpdate would skip the pre-save profit-computation hook —
        // fetch, assign, and save() so totals/profit actually recompute.
        savedDoc = await EcommerceOrderProfit.findById(docId);
        Object.assign(savedDoc, fields);
        await savedDoc.save();
      }
      updated += 1;
    } else {
      const fields = await rebuildDocContents(orderNumbers, orderByNumber, dryRun);
      const earliestOrderDate = fields.orders.map((o) => o.orderDate).filter(Boolean).sort()[0] || new Date();
      const docPayload = {
        organization: ORGANIZATION_ID,
        storeName: STORE_NAME,
        vendorSource: "ebay",
        orderDate: earliestOrderDate,
        notes: AUTO_SYNC_NOTE,
        ...fields,
      };

      if (dryRun) {
        preview.push({ action: "create", ...docPayload });
      } else {
        savedDoc = await EcommerceOrderProfit.create(docPayload);
      }
      created += 1;
    }

    // Fold in this month's operating expenses (employee salary, handling,
    // rent, etc. — entered once via the Accounting module) divided equally
    // across every order in the month, same mechanism every other business
    // line already uses. Never runs during a dry run (it writes for real).
    if (savedDoc && !dryRun) {
      await recalcForBatch(ORGANIZATION_ID, savedDoc);
    }
  }

  return {
    created,
    updated,
    skippedHistorical,
    skippedAmbiguous,
    skippedNoShopifyOrder,
    ...(dryRun ? { preview } : {}),
  };
}

module.exports = { syncCrmProfitRecords };
