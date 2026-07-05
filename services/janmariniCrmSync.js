// Mirrors confirmed Janmarini fulfillment data into Codex CRM's own
// EcommerceOrderProfit collection (default "test" DB connection — NOT the
// separate janmarini_fulfillment connection), so accounting has an audit
// trail without anyone re-typing numbers by hand.
//
// One EcommerceOrderProfit document per Shopify order, going forward only.
// Orders that already have a record (the 5 historical batches entered by hand
// for #1750-#1759) are left completely alone — we never touch pre-existing
// CRM data, only create/refresh records for orders that don't have one yet.
//
// Fee methodology matches the CRM's own accounting convention (see the
// profit-discrepancy investigation): 3% payment gateway + 2.9% Shopify fee on
// revenue. No operating-expense share is set here — that's a monthly
// allocation the accountant applies separately.
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const Purchase = require("../models/janmarini/Purchase");
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");

const ORGANIZATION_ID = "6a308a0ff2cebbca8453bc2c"; // Codex FZE Technology
const STORE_NAME = "Janmarini";
const AUTO_SYNC_NOTE = "Auto-synced by Janmarini Tracking automation";
const PAYMENT_GATEWAY_FEE_PCT = 3;
const SHOPIFY_FEE_PCT = 2.9;
const AED_PER_USD = 3.8;

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function syncCrmProfitRecords() {
  const existingOrderNumbers = new Set(
    (
      await EcommerceOrderProfit.find({ organization: ORGANIZATION_ID }).select("orders.orderNumber").lean()
    ).flatMap((doc) => (doc.orders || []).map((o) => o.orderNumber))
  );

  const orders = await ShopifyOrder.find({ ignored: false }).lean();
  let created = 0;
  let updated = 0;
  let skippedNoPurchase = 0;

  for (const order of orders) {
    if (existingOrderNumbers.has(order.orderNumber)) continue; // never touch historical/manual records

    const purchases = await Purchase.find({ orderNumber: order.orderNumber })
      .populate("inboundShipment", "snsShipmentNumber feesAED")
      .lean();
    const withCost = purchases.filter((p) => p.costUSD > 0);
    if (!withCost.length) {
      skippedNoPurchase += 1;
      continue; // nothing bought yet — not ready for the accounting record
    }

    const products = withCost.map((p) => ({
      name: p.itemName,
      quantity: p.quantity || 1,
      cost: round((p.costUSD * AED_PER_USD) / (p.quantity || 1)), // schema expects unit cost
    }));

    const shipmentIds = new Set();
    let shippingCost = 0;
    for (const p of withCost) {
      if (p.inboundShipment && !shipmentIds.has(String(p.inboundShipment._id))) {
        shipmentIds.add(String(p.inboundShipment._id));
        shippingCost += Number(p.inboundShipment.feesAED) || 0;
      }
    }

    const aramexTracking = [...new Set(withCost.map((p) => p.inboundShipment?.snsShipmentNumber).filter(Boolean))].join(", ");
    const sellerTracking = [...new Set(withCost.map((p) => p.sellerTracking).filter(Boolean))].join(", ");
    const revenue = Number(order.totalPrice) || 0;

    const orderLine = {
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      customerPaidAmount: revenue,
      currency: order.currency || "AED",
      aedAmount: revenue, // store currency is AED — no conversion needed
      sellerTracking,
      aramexTracking,
      products,
    };

    const existing = await EcommerceOrderProfit.findOne({
      organization: ORGANIZATION_ID,
      notes: AUTO_SYNC_NOTE,
      "orders.orderNumber": order.orderNumber,
    });

    if (existing) {
      existing.orders = [orderLine];
      existing.shippingCost = round(shippingCost);
      existing.paymentGatewayFeePct = PAYMENT_GATEWAY_FEE_PCT;
      existing.shopifyFeePct = SHOPIFY_FEE_PCT;
      await existing.save();
      updated += 1;
    } else {
      await EcommerceOrderProfit.create({
        organization: ORGANIZATION_ID,
        storeName: STORE_NAME,
        vendorSource: "ebay",
        orders: [orderLine],
        shippingCost: round(shippingCost),
        paymentGatewayFeePct: PAYMENT_GATEWAY_FEE_PCT,
        shopifyFeePct: SHOPIFY_FEE_PCT,
        orderDate: order.orderDate,
        notes: AUTO_SYNC_NOTE,
      });
      created += 1;
    }
  }

  return { created, updated, skippedNoPurchase };
}

module.exports = { syncCrmProfitRecords };
