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
// revenue. No operating-expense share is set here — that's a monthly
// allocation the accountant applies separately.
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const Purchase = require("../models/janmarini/Purchase");
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");
const { ensureOrderInvoice } = require("./janmariniInvoice");

const ORGANIZATION_ID = "6a308a0ff2cebbca8453bc2c"; // Codex FZE Technology
const STORE_NAME = "Janmarini";
const AUTO_SYNC_NOTE = "Auto-synced by Janmarini Tracking automation";
const PAYMENT_GATEWAY_FEE_PCT = 3;
const SHOPIFY_FEE_PCT = 2.9;
const AED_PER_USD = 3.8;

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

async function syncCrmProfitRecords({ dryRun = false } = {}) {
  const existingDocs = await EcommerceOrderProfit.find({ organization: ORGANIZATION_ID })
    .select("orders.orderNumber notes")
    .lean();
  const existingByDigits = new Map(); // digitsOnly(orderNumber) -> { docId, isAuto }
  for (const doc of existingDocs) {
    for (const o of doc.orders || []) {
      existingByDigits.set(digitsOnly(o.orderNumber), { docId: doc._id, isAuto: doc.notes === AUTO_SYNC_NOTE });
    }
  }

  const shopifyOrders = await ShopifyOrder.find({ ignored: false }).lean();
  const orderByNumber = new Map(shopifyOrders.map((o) => [o.orderNumber, o]));

  const purchases = await Purchase.find({ costUSD: { $gt: 0 } })
    .populate("inboundShipment", "snsShipmentNumber feesAED")
    .lean();

  // Group into eBay-checkout batches. Purchases with no ebayOrderNumber yet
  // (data-entry gap) each become their own singleton batch rather than being
  // silently lumped together under one empty key.
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

    const shopifyOrdersInBatch = orderNumbers.map((n) => orderByNumber.get(n)).filter(Boolean);
    if (shopifyOrdersInBatch.length !== orderNumbers.length) {
      skippedNoShopifyOrder += 1; // a purchase references a Shopify order we don't have (ignored/typo)
      continue;
    }

    const orderLines = await Promise.all(
      shopifyOrdersInBatch.map((order) =>
        buildOrderLine(order, batchPurchases.filter((p) => p.orderNumber === order.orderNumber), dryRun)
      )
    );

    // Shared batch-level cost: shipping fees, deduped by shipment (several
    // items in the batch usually travel in the same box), and the eBay
    // purchase receipt(s) — deduped by URL since one receipt often covers
    // every item in the batch.
    const shipmentIds = new Set();
    let shippingCost = 0;
    for (const p of batchPurchases) {
      if (p.inboundShipment && !shipmentIds.has(String(p.inboundShipment._id))) {
        shipmentIds.add(String(p.inboundShipment._id));
        shippingCost += Number(p.inboundShipment.feesAED) || 0;
      }
    }
    const goodsReceiptFiles = [
      ...new Map(
        batchPurchases.flatMap((p) => p.receiptFiles || []).map((url) => [url, { fileName: "", fileUrl: url }])
      ).values(),
    ];

    const earliestOrderDate = orderLines.map((o) => o.orderDate).filter(Boolean).sort()[0] || new Date();

    const updateFields = {
      orders: orderLines,
      shippingCost: round(shippingCost),
      paymentGatewayFeePct: PAYMENT_GATEWAY_FEE_PCT,
      shopifyFeePct: SHOPIFY_FEE_PCT,
      goodsReceiptFiles,
    };

    if (autoDocIds.size === 1) {
      const docId = [...autoDocIds][0];
      if (dryRun) {
        preview.push({ action: "update", docId, ...updateFields });
      } else {
        await EcommerceOrderProfit.findByIdAndUpdate(docId, updateFields);
      }
      updated += 1;
      continue;
    }

    const docPayload = {
      organization: ORGANIZATION_ID,
      storeName: STORE_NAME,
      vendorSource: "ebay",
      orderDate: earliestOrderDate,
      notes: AUTO_SYNC_NOTE,
      ...updateFields,
    };

    if (dryRun) {
      preview.push({ action: "create", ...docPayload });
    } else {
      await EcommerceOrderProfit.create(docPayload);
    }
    created += 1;
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
