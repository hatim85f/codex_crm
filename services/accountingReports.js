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

  const [invoices, expenses, bankCount] = await Promise.all([
    Invoice.find(invMatch).select("grandTotal paidAmount balance").lean(),
    Expense.find(expMatch).select("aedAmount status").lean(),
    BankAccount.countDocuments({ organization, status: "active" }),
  ]);

  const totalIncome = round(sum(invoices, (i) => i.grandTotal));
  const collected = round(sum(invoices, (i) => i.paidAmount));
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
    EcommerceOrderProfit.find(ecomMatch).select("aedAmount productBuyingCost shopAndShipCost courierDeliveryCost packingHandlingCost stripeFee shopifyFee employeeHandlingAllocation").lean(),
  ]);

  const invoiceRevenue = round(sum(invoices, (i) => i.grandTotal));
  const ecomRevenue = round(sum(ecom, (e) => e.aedAmount));
  const revenue = round(invoiceRevenue + ecomRevenue);

  // Expenses grouped by category.
  const byCat = {};
  expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + (Number(e.aedAmount) || 0); });

  const ecomCogs = round(sum(ecom, (e) => (e.productBuyingCost || 0) + (e.shopAndShipCost || 0) + (e.courierDeliveryCost || 0) + (e.packingHandlingCost || 0)));
  const ecomOpex = round(sum(ecom, (e) => (e.stripeFee || 0) + (e.shopifyFee || 0) + (e.employeeHandlingAllocation || 0)));

  const cogsExpenses = round(COGS_CATEGORIES.reduce((s, c) => s + (byCat[c] || 0), 0));
  const cogs = round(cogsExpenses + ecomCogs);

  const opexCats = Object.keys(byCat).filter((c) => !COGS_CATEGORIES.includes(c));
  const opexExpenses = round(opexCats.reduce((s, c) => s + byCat[c], 0));
  const operatingExpenses = round(opexExpenses + ecomOpex);

  const netProfit = round(revenue - cogs - operatingExpenses);
  const margin = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0;

  const opexLines = opexCats.map((c) => ({ key: c, amount: round(byCat[c]) }));
  if (ecomOpex) opexLines.push({ key: "ecommerce_fees", amount: ecomOpex });

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
      cogs: [
        ...COGS_CATEGORIES.filter((c) => byCat[c]).map((c) => ({ key: c, amount: round(byCat[c]) })),
        ecomCogs ? { key: "ecommerce_cogs", amount: ecomCogs } : null,
      ].filter(Boolean),
      opex: opexLines,
    },
  };
}

module.exports = { computeOverview, computePnl };
