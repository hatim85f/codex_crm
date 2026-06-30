// Distributes a month's operating expenses (salary, etc.) EQUALLY across every
// eCommerce order placed that month, baking each order's share into its stored
// profit. Because a month's orders can span several batches, this recompute
// works across all batches that have an order in the month.
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");
const EcomOperatingExpense = require("../models/EcomOperatingExpense");

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// {year, month(1-12)} for a Date (UTC).
function ym(date) {
  const d = new Date(date);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function monthRange(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

// Distinct {year, month} pairs across a batch's orders (by orderDate).
function monthsForBatch(batch) {
  const seen = new Map();
  (batch.orders || []).forEach((o) => {
    if (!o.orderDate) return;
    const { year, month } = ym(o.orderDate);
    seen.set(`${year}-${month}`, { year, month });
  });
  return [...seen.values()];
}

// Recompute and store every order's operating-expense share for one month.
async function recalcMonthlyOpex(organization, year, month) {
  const { start, end } = monthRange(year, month);

  const expenses = await EcomOperatingExpense.find({ organization, periodYear: year, periodMonth: month, isDeleted: false });
  const opexTotal = round(expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));

  // Every non-deleted batch that has at least one order in this month.
  const batches = await EcommerceOrderProfit.find({
    organization,
    isDeleted: false,
    "orders.orderDate": { $gte: start, $lt: end },
  });

  // Count orders that fall in this month across all batches.
  let count = 0;
  batches.forEach((b) => (b.orders || []).forEach((o) => {
    if (o.orderDate && o.orderDate >= start && o.orderDate < end) count += 1;
  }));

  const perOrder = count > 0 ? round(opexTotal / count) : 0;

  // Apply the share to in-month orders and re-save (pre-save folds it into profit).
  for (const b of batches) {
    let changed = false;
    (b.orders || []).forEach((o) => {
      if (o.orderDate && o.orderDate >= start && o.orderDate < end) {
        if (round(o.operatingExpenseShare) !== perOrder) { o.operatingExpenseShare = perOrder; changed = true; }
      }
    });
    if (changed) await b.save();
  }

  return { opexTotal, count, perOrder };
}

// Recompute every month touched by a batch (used after a batch is saved/removed).
async function recalcForBatch(organization, batch) {
  for (const { year, month } of monthsForBatch(batch)) {
    await recalcMonthlyOpex(organization, year, month);
  }
}

module.exports = { recalcMonthlyOpex, recalcForBatch, monthsForBatch, ym };
