// Shared accounting computations (overview + P&L) used by both the internal
// accounting routes and the read-only auditor routes.
const Invoice = require("../models/Invoice");
const Expense = require("../models/Expense");
const EcommerceOrderProfit = require("../models/EcommerceOrderProfit");
const BankAccount = require("../models/BankAccount");

const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function dateClause(field, from, to) {
  if (!from && !to) return {};
  const c = {};
  if (from) c.$gte = new Date(from);
  if (to) c.$lte = new Date(to);
  return { [field]: c };
}

// COGS = direct cost of goods/fulfilment; everything else = operating expense.
const COGS_CATEGORIES = ["cogs", "shipping", "courier_delivery"];

async function computeOverview(organization, { from, to, businessLine } = {}) {
  const invMatch = { organization, status: { $ne: "cancelled" }, ...dateClause("issueDate", from, to) };
  if (businessLine) invMatch.businessLine = businessLine;
  const expMatch = { organization, isDeleted: false, ...dateClause("expenseDate", from, to) };
  if (businessLine) expMatch.businessLine = businessLine;

  const ecomMatch = { organization, isDeleted: false, ...dateClause("orderDate", from, to) };
  if (businessLine) ecomMatch.businessLine = businessLine;

  const [invoices, expenses, ecom, bankCount] = await Promise.all([
    Invoice.find(invMatch).select("grandTotal paidAmount balance").lean(),
    Expense.find(expMatch).select("aedAmount status").lean(),
    EcommerceOrderProfit.find(ecomMatch).select("aedAmount").lean(),
    BankAccount.countDocuments({ organization, status: "active" }),
  ]);

  // Income = client invoices + eCommerce sales (their costs are in the expense ledger).
  const ecomRevenue = round(sum(ecom, (e) => e.aedAmount));
  const totalIncome = round(sum(invoices, (i) => i.grandTotal) + ecomRevenue);
  const collected = round(sum(invoices, (i) => i.paidAmount) + ecomRevenue);
  const outstanding = round(sum(invoices.filter((i) => (i.balance || 0) > 0), (i) => i.balance));
  const outstandingCount = invoices.filter((i) => (i.balance || 0) > 0).length;
  const totalExpenses = round(sum(expenses, (e) => e.aedAmount));
  const pending = expenses.filter((e) => e.status === "pending");
  const pendingExpenses = round(sum(pending, (e) => e.aedAmount));

  return {
    totalIncome,
    totalExpenses,
    netProfit: round(totalIncome - totalExpenses),
    outstandingInvoices: { amount: outstanding, count: outstandingCount },
    collectedPayments: collected,
    pendingExpenses: { amount: pendingExpenses, count: pending.length },
    bankBalance: round(collected - totalExpenses), // derived net-cash position
    bankAccounts: bankCount,
  };
}

async function computePnl(organization, { from, to, businessLine } = {}) {
  const invMatch = { organization, status: { $ne: "cancelled" }, ...dateClause("issueDate", from, to) };
  if (businessLine) invMatch.businessLine = businessLine;
  const expMatch = { organization, isDeleted: false, ...dateClause("expenseDate", from, to) };
  if (businessLine) expMatch.businessLine = businessLine;
  const ecomMatch = { organization, isDeleted: false, ...dateClause("orderDate", from, to) };
  if (businessLine) ecomMatch.businessLine = businessLine;

  const [invoices, expenses, ecom] = await Promise.all([
    Invoice.find(invMatch).select("grandTotal").lean(),
    Expense.find(expMatch).select("aedAmount category").lean(),
    EcommerceOrderProfit.find(ecomMatch).select("aedAmount").lean(),
  ]);

  const invoiceRevenue = round(sum(invoices, (i) => i.grandTotal));
  // eCommerce sales are income; their COSTS are posted to Expenses (services/ecomLedger.js)
  // so we only read revenue here — costs come from the expense ledger below (no double count).
  const ecomRevenue = round(sum(ecom, (e) => e.aedAmount));
  const revenue = round(invoiceRevenue + ecomRevenue);

  // Expenses grouped by category (includes auto-posted eCommerce COGS + fees).
  const byCat = {};
  expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + (Number(e.aedAmount) || 0); });

  const cogs = round(COGS_CATEGORIES.reduce((s, c) => s + (byCat[c] || 0), 0));
  const opexCats = Object.keys(byCat).filter((c) => !COGS_CATEGORIES.includes(c));
  const operatingExpenses = round(opexCats.reduce((s, c) => s + byCat[c], 0));

  const netProfit = round(revenue - cogs - operatingExpenses);
  const margin = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0;

  return {
    revenue,
    cogs,
    operatingExpenses,
    netProfit,
    margin,
    lines: {
      revenue: [
        invoiceRevenue ? { key: "service_invoices", amount: invoiceRevenue } : null,
        ecomRevenue ? { key: "ecommerce_sales", amount: ecomRevenue } : null,
      ].filter(Boolean),
      cogs: COGS_CATEGORIES.filter((c) => byCat[c]).map((c) => ({ key: c, amount: round(byCat[c]) })),
      opex: opexCats.map((c) => ({ key: c, amount: round(byCat[c]) })),
    },
  };
}

// Audit checklist items the system satisfies automatically from generated data.
async function auditAutoAvailability(organization, period) {
  const yr = Number(period);
  const range = (yr && yr > 2000) ? { issueDate: { $gte: new Date(yr, 0, 1), $lt: new Date(yr + 1, 0, 1) } } : {};
  const [invCount, paidCount] = await Promise.all([
    Invoice.countDocuments({ organization, status: { $ne: "cancelled" }, ...range }),
    Invoice.countDocuments({ organization, paidAmount: { $gt: 0 }, ...range }),
  ]);
  return {
    sales_invoices: { available: invCount > 0, count: invCount, view: "invoices" },
    payment_proofs: { available: paidCount > 0, count: paidCount, view: "payments" },
    pnl_report: { available: true, count: null, view: "pnl" },
  };
}

// Decorate audit items with auto-availability + return updated stats.
function applyAuditAuto(rawItems, auto) {
  const items = rawItems.map((i) => {
    const a = auto[i.key];
    return a ? { ...i, autoAvailable: a.available, autoCount: a.count, autoView: a.view } : i;
  });
  const isReady = (i) => i.autoAvailable || ["ready", "shared_with_auditor"].includes(i.status);
  const total = items.length;
  return {
    items,
    stats: {
      total,
      ready: items.filter(isReady).length,
      missing: items.filter((i) => i.status === "missing" && !i.autoAvailable).length,
      shared: items.filter((i) => i.status === "shared_with_auditor").length,
      health: total ? Math.round((items.filter(isReady).length / total) * 100) : 0,
    },
  };
}

module.exports = { computeOverview, computePnl, auditAutoAvailability, applyAuditAuto };
