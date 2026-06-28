// Posts a dropshipping order's costs into the Expenses ledger so the P&L is
// driven by one set of ledgers (invoices + eCommerce sales for income; expenses
// for cost). Idempotent: re-running updates the same linked expense rows.
const Expense = require("../models/Expense");

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Upsert (or remove if zero) the expense for one cost component of an order.
async function upsertOne(order, userId, kind, amount, extra) {
  const filter = { organization: order.organization, sourceOrderProfitId: order._id, sourceKind: kind };
  if (!(amount > 0)) { await Expense.deleteOne(filter); return; }
  const exists = await Expense.findOne(filter);
  const base = {
    organization: order.organization,
    vendor: order.vendorSource || order.storeName || "",
    businessLine: order.businessLine,
    originalCurrency: "AED",
    originalAmount: amount,
    aedAmount: amount,
    paymentMethod: "online",
    expenseDate: order.orderDate || new Date(),
    status: "paid",
    updatedBy: userId,
    sourceOrderProfitId: order._id,
    sourceKind: kind,
    ...extra,
  };
  if (exists) {
    // Preserve a manually-edited vendor/entity across re-syncs.
    const { vendor, ...rest } = base;
    Object.assign(exists, rest);
    if (!exists.vendor) exists.vendor = vendor;
    await exists.save();
  } else {
    const expenseNumber = (await Expense.countDocuments({ organization: order.organization })) + 1001;
    await Expense.create({ ...base, expenseNumber, createdBy: userId });
  }
}

// Sync an order's COGS + fees expenses.
async function syncOrderExpenses(order, userId) {
  const orders = order.orders || [];
  const label = `${order.storeName}${orders.length > 1 ? ` (${orders.length} orders)` : orders[0]?.orderNumber ? ` ${orders[0].orderNumber}` : ""}`.trim();
  const cogs = round((order.productBuyingCost || 0) + (order.shippingCost || 0) + (order.courierDeliveryCost || 0) + (order.packingHandlingCost || 0));
  const fees = round((order.paymentGatewayFee || 0) + (order.shopifyFee || 0));
  await upsertOne(order, userId, "cogs", cogs, {
    title: `COGS — ${label}`,
    category: "cogs",
    receiptAttachments: (order.goodsReceiptFiles || []).map((f) => ({ fileName: f.fileName || "", fileUrl: f.fileUrl })),
    notes: "Auto-posted from eCommerce order profit.",
  });
  await upsertOne(order, userId, "fees", fees, {
    title: `Gateway fees — ${label}`,
    category: "payment_gateway_fees",
    notes: "Auto-posted from eCommerce order profit.",
  });
}

// Soft-delete the linked expenses when an order is removed.
async function removeOrderExpenses(organization, orderId) {
  await Expense.updateMany({ organization, sourceOrderProfitId: orderId }, { $set: { isDeleted: true } });
}

module.exports = { syncOrderExpenses, removeOrderExpenses };
