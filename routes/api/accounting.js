const express = require("express");

const router = express.Router();
const Invoice = require("../../models/Invoice");
const Expense = require("../../models/Expense");
const EcommerceOrderProfit = require("../../models/EcommerceOrderProfit");
const EcomOperatingExpense = require("../../models/EcomOperatingExpense");
const PaymentGatewayUpload = require("../../models/PaymentGatewayUpload");
const BankStatement = require("../../models/BankStatement");
const AuditItem = require("../../models/AuditItem");
const { auth, requireRole } = require("../../middleware/auth");
const { computeOverview, computePnl, auditAutoAvailability, applyAuditAuto } = require("../../services/accountingReports");
const { syncOrderExpenses, removeOrderExpenses } = require("../../services/ecomLedger");
const { recalcForBatch, recalcMonthlyOpex, monthsForBatch } = require("../../services/opexAllocation");
const {
  EXPENSE_CATEGORIES, EXPENSE_STATUSES, PAYMENT_METHODS, BUSINESS_LINES,
  GATEWAY_PROVIDERS, GATEWAY_STATUSES, BANK_STATEMENT_STATUSES, AUDIT_STATUSES, AUDIT_ITEMS,
} = require("../../services/accountingConstants");

// Accounting is sensitive: accountants + admins manage; team_leader can view.
const VIEW = ["owner_admin", "admin", "accountant", "team_leader"];
const MANAGE = ["owner_admin", "admin", "accountant"];

router.use(auth);
router.use(requireRole(...VIEW));
const canManage = requireRole(...MANAGE);

const org = (req) => req.user.organization;
const num = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v) || 0);
const dateRange = (req) => ({ from: req.query.from, to: req.query.to, businessLine: req.query.businessLine });

// ---------------- Overview ----------------
router.get("/overview", async (req, res) => {
  try {
    return res.json(await computeOverview(org(req), dateRange(req)));
  } catch (err) {
    console.error("overview error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---------------- P&L ----------------
router.get("/pnl", async (req, res) => {
  try {
    return res.json(await computePnl(org(req), dateRange(req)));
  } catch (err) {
    console.error("pnl error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---------------- Expenses ----------------
router.get("/expenses", async (req, res) => {
  try {
    const { search, category, businessLine, status, from, to } = req.query;
    const q = { organization: org(req), isDeleted: false };
    if (category) q.category = category;
    if (businessLine) q.businessLine = businessLine;
    if (status) q.status = status;
    if (from || to) { q.expenseDate = {}; if (from) q.expenseDate.$gte = new Date(from); if (to) q.expenseDate.$lte = new Date(to); }
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ title: rx }, { vendor: rx }, { notes: rx }];
    }
    const items = await Expense.find(q).populate("createdBy", "name avatar").sort({ expenseDate: -1 }).limit(500);
    return res.json(items);
  } catch (err) {
    console.error("list expenses error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

const expenseBody = (b, userId) => ({
  title: b.title,
  vendor: b.vendor || "",
  category: EXPENSE_CATEGORIES.includes(b.category) ? b.category : "other",
  businessLine: BUSINESS_LINES.includes(b.businessLine) ? b.businessLine : "other",
  originalCurrency: b.originalCurrency || "AED",
  originalAmount: num(b.originalAmount),
  aedAmount: num(b.aedAmount),
  paymentMethod: PAYMENT_METHODS.includes(b.paymentMethod) ? b.paymentMethod : "bank_transfer",
  expenseDate: b.expenseDate || new Date(),
  receiptAttachments: Array.isArray(b.receiptAttachments)
    ? b.receiptAttachments.filter((a) => a && a.fileUrl).map((a) => ({ fileName: a.fileName || "", fileUrl: a.fileUrl }))
    : (b.receiptAttachment?.fileUrl ? [{ fileName: b.receiptAttachment.fileName || "", fileUrl: b.receiptAttachment.fileUrl }] : []),
  paymentProofAttachment: b.paymentProofAttachment || { fileName: "", fileUrl: "" },
  notes: b.notes || "",
  status: EXPENSE_STATUSES.includes(b.status) ? b.status : "pending",
  updatedBy: userId,
});

router.post("/expenses", canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ message: "Title is required" });
    const expenseNumber = (await Expense.countDocuments({ organization: org(req) })) + 1001;
    const created = await Expense.create({ organization: org(req), expenseNumber, createdBy: req.user.id, ...expenseBody(b, req.user.id) });
    const out = await Expense.findById(created._id).populate("createdBy", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("create expense error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/expenses/:id", async (req, res) => {
  try {
    const e = await Expense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false }).populate("createdBy", "name avatar");
    if (!e) return res.status(404).json({ message: "Expense not found" });
    return res.json(e);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.put("/expenses/:id", canManage, async (req, res) => {
  try {
    const e = await Expense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!e) return res.status(404).json({ message: "Expense not found" });
    Object.assign(e, expenseBody(req.body || {}, req.user.id));
    await e.save();
    const out = await Expense.findById(e._id).populate("createdBy", "name avatar");
    return res.json(out);
  } catch (err) {
    console.error("update expense error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Partial update (e.g. inline rename of the vendor / entity from the overview).
router.patch("/expenses/:id", canManage, async (req, res) => {
  try {
    const e = await Expense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!e) return res.status(404).json({ message: "Expense not found" });
    const b = req.body || {};
    const enums = { category: EXPENSE_CATEGORIES, businessLine: BUSINESS_LINES, status: EXPENSE_STATUSES, paymentMethod: PAYMENT_METHODS };
    ["vendor", "title", "notes", "aedAmount", "originalAmount", "originalCurrency", "expenseDate", "category", "businessLine", "status", "paymentMethod"].forEach((f) => {
      if (b[f] === undefined) return;
      if (enums[f] && !enums[f].includes(b[f])) return;
      e[f] = b[f];
    });
    e.updatedBy = req.user.id;
    await e.save();
    const out = await Expense.findById(e._id).populate("createdBy", "name avatar");
    return res.json(out);
  } catch (err) {
    console.error("patch expense error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.delete("/expenses/:id", canManage, async (req, res) => {
  try {
    const e = await Expense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!e) return res.status(404).json({ message: "Expense not found" });
    e.isDeleted = true; e.updatedBy = req.user.id; await e.save();
    return res.json({ ok: true, _id: e._id });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// ---------------- eCommerce order profit ----------------
const ecomFields = ["storeName", "businessLine", "vendorSource", "orders",
  "shippingCost", "courierDeliveryCost", "packingHandlingCost",
  "paymentGatewayFeePct", "shopifyFeePct", "orderDate", "notes", "goodsReceiptFiles"];

router.get("/ecommerce", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.businessLine) q.businessLine = req.query.businessLine;
    if (req.query.store) q.storeName = new RegExp(String(req.query.store).trim(), "i");
    const items = await EcommerceOrderProfit.find(q).sort({ orderDate: -1 }).limit(500);
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.post("/ecommerce", canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.storeName) return res.status(400).json({ message: "Store name is required" });
    const doc = new EcommerceOrderProfit({ organization: org(req), createdBy: req.user.id, updatedBy: req.user.id });
    ecomFields.forEach((f) => { if (b[f] !== undefined) doc[f] = b[f]; });
    if (!BUSINESS_LINES.includes(doc.businessLine)) doc.businessLine = "own_ecommerce_dropshipping";
    await doc.save(); // pre-save computes totalCost/netProfit/profitMargin
    await recalcForBatch(org(req), doc); // distribute month's operating expenses across orders
    const fresh = await EcommerceOrderProfit.findById(doc._id);
    await syncOrderExpenses(fresh, req.user.id); // post COGS + fees to Expenses
    return res.status(201).json(fresh);
  } catch (err) {
    console.error("create ecom error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/ecommerce/:id", async (req, res) => {
  try {
    const d = await EcommerceOrderProfit.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Record not found" });
    return res.json(d);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.put("/ecommerce/:id", canManage, async (req, res) => {
  try {
    const d = await EcommerceOrderProfit.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Record not found" });
    const b = req.body || {};
    ecomFields.forEach((f) => { if (b[f] !== undefined) d[f] = b[f]; });
    d.updatedBy = req.user.id;
    await d.save();
    await recalcForBatch(org(req), d); // re-distribute month's operating expenses
    const fresh = await EcommerceOrderProfit.findById(d._id);
    await syncOrderExpenses(fresh, req.user.id); // keep linked Expenses in sync
    return res.json(fresh);
  } catch (err) {
    console.error("update ecom error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.delete("/ecommerce/:id", canManage, async (req, res) => {
  try {
    const d = await EcommerceOrderProfit.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Record not found" });
    const months = monthsForBatch(d); // capture before delete — orders leave the month
    d.isDeleted = true; d.updatedBy = req.user.id; await d.save();
    await removeOrderExpenses(org(req), d._id); // remove the linked Expenses
    for (const m of months) await recalcMonthlyOpex(org(req), m.year, m.month); // re-spread remaining orders' share
    return res.json({ ok: true, _id: d._id });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// Recompute every batch's profit (re-saves to clear legacy packing/handling and
// re-apply monthly operating-expense shares) + re-sync the Expense ledger.
router.post("/ecommerce/recalculate", canManage, async (req, res) => {
  try {
    const all = await EcommerceOrderProfit.find({ organization: org(req), isDeleted: false });
    for (const b of all) { await b.save(); await syncOrderExpenses(b, req.user.id); }
    const months = new Map();
    all.forEach((b) => monthsForBatch(b).forEach((m) => months.set(`${m.year}-${m.month}`, m)));
    for (const m of months.values()) await recalcMonthlyOpex(org(req), m.year, m.month);
    return res.json({ ok: true, batches: all.length });
  } catch (err) {
    console.error("recalc ecom error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---------------- eCommerce monthly operating expenses ----------------
// Entered once per month; divided equally across that month's orders.
router.get("/ecommerce-operating-expenses", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.year) q.periodYear = Number(req.query.year);
    if (req.query.month) q.periodMonth = Number(req.query.month);
    const items = await EcomOperatingExpense.find(q).sort({ periodYear: -1, periodMonth: -1, createdAt: 1 });
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.post("/ecommerce-operating-expenses", canManage, async (req, res) => {
  try {
    const b = req.body || {};
    const year = Number(b.periodYear), month = Number(b.periodMonth);
    if (!b.label || !year || !(month >= 1 && month <= 12)) return res.status(400).json({ message: "Label, year and month (1-12) are required" });
    const doc = await EcomOperatingExpense.create({
      organization: org(req), periodYear: year, periodMonth: month,
      label: b.label, amount: Number(b.amount) || 0, notes: b.notes || "",
      createdBy: req.user.id, updatedBy: req.user.id,
    });
    await recalcMonthlyOpex(org(req), year, month);
    return res.status(201).json(doc);
  } catch (err) {
    console.error("create opex error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.put("/ecommerce-operating-expenses/:id", canManage, async (req, res) => {
  try {
    const d = await EcomOperatingExpense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Record not found" });
    const b = req.body || {};
    const oldY = d.periodYear, oldM = d.periodMonth;
    if (b.label !== undefined) d.label = b.label;
    if (b.amount !== undefined) d.amount = Number(b.amount) || 0;
    if (b.notes !== undefined) d.notes = b.notes;
    if (b.periodYear !== undefined) d.periodYear = Number(b.periodYear);
    if (b.periodMonth !== undefined) d.periodMonth = Number(b.periodMonth);
    d.updatedBy = req.user.id;
    await d.save();
    await recalcMonthlyOpex(org(req), oldY, oldM);
    if (d.periodYear !== oldY || d.periodMonth !== oldM) await recalcMonthlyOpex(org(req), d.periodYear, d.periodMonth);
    return res.json(d);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.delete("/ecommerce-operating-expenses/:id", canManage, async (req, res) => {
  try {
    const d = await EcomOperatingExpense.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Record not found" });
    d.isDeleted = true; d.updatedBy = req.user.id; await d.save();
    await recalcMonthlyOpex(org(req), d.periodYear, d.periodMonth);
    return res.json({ ok: true, _id: d._id });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// ---------------- Payment gateway uploads ----------------
router.get("/gateway-uploads", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.provider) q.provider = req.query.provider;
    if (req.query.status) q.status = req.query.status;
    const items = await PaymentGatewayUpload.find(q).populate("uploadedBy", "name avatar").sort({ createdAt: -1 }).limit(200);
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.post("/gateway-uploads", canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!GATEWAY_PROVIDERS.includes(b.provider)) return res.status(400).json({ message: "Invalid provider" });
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const totalGross = rows.reduce((s, r) => s + (Number(r.grossAmount) || 0), 0);
    const totalFees = rows.reduce((s, r) => s + (Number(r.fees) || 0), 0);
    const totalNet = rows.reduce((s, r) => s + (Number(r.netReceived) || 0), 0);
    const doc = await PaymentGatewayUpload.create({
      organization: org(req), provider: b.provider,
      month: b.month || null, year: b.year || null,
      fileName: b.fileName || "", fileUrl: b.fileUrl || "",
      status: "uploaded", rows, rowCount: rows.length,
      totalGross, totalFees, totalNet,
      notes: b.notes || "", uploadedBy: req.user.id,
    });
    const out = await PaymentGatewayUpload.findById(doc._id).populate("uploadedBy", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("gateway upload error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/gateway-uploads/:id", async (req, res) => {
  try {
    const d = await PaymentGatewayUpload.findOne({ _id: req.params.id, organization: org(req), isDeleted: false }).populate("uploadedBy", "name avatar");
    if (!d) return res.status(404).json({ message: "Upload not found" });
    return res.json(d);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.patch("/gateway-uploads/:id/status", canManage, async (req, res) => {
  try {
    if (!GATEWAY_STATUSES.includes(req.body?.status)) return res.status(400).json({ message: "Invalid status" });
    const d = await PaymentGatewayUpload.findOneAndUpdate(
      { _id: req.params.id, organization: org(req), isDeleted: false },
      { $set: { status: req.body.status } }, { new: true }
    );
    if (!d) return res.status(404).json({ message: "Upload not found" });
    return res.json({ ok: true, _id: d._id, status: d.status });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.delete("/gateway-uploads/:id", canManage, async (req, res) => {
  try {
    const d = await PaymentGatewayUpload.findOneAndUpdate(
      { _id: req.params.id, organization: org(req) }, { $set: { isDeleted: true } }, { new: true });
    if (!d) return res.status(404).json({ message: "Upload not found" });
    return res.json({ ok: true, _id: d._id });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// ---------------- Bank statements ----------------
router.get("/bank-statements", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.year) q.year = Number(req.query.year);
    if (req.query.bankAccountId) q.bankAccountId = req.query.bankAccountId;
    const items = await BankStatement.find(q).populate("bankAccountId", "bankName accountNumber currency logo").populate("uploadedBy", "name avatar").sort({ year: -1, month: -1 });
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.post("/bank-statements", canManage, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.bankAccountId || !b.month || !b.year) return res.status(400).json({ message: "Bank, month and year are required" });
    const doc = await BankStatement.create({
      organization: org(req), bankAccountId: b.bankAccountId,
      month: Number(b.month), year: Number(b.year),
      statementFile: b.statementFile || { fileName: "", fileUrl: "" },
      notes: b.notes || "", auditStatus: BANK_STATEMENT_STATUSES.includes(b.auditStatus) ? b.auditStatus : "pending",
      uploadedBy: req.user.id,
    });
    const out = await BankStatement.findById(doc._id).populate("bankAccountId", "bankName accountNumber currency logo").populate("uploadedBy", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("bank statement error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/bank-statements/:id", canManage, async (req, res) => {
  try {
    const d = await BankStatement.findOne({ _id: req.params.id, organization: org(req), isDeleted: false });
    if (!d) return res.status(404).json({ message: "Statement not found" });
    const b = req.body || {};
    if (b.auditStatus !== undefined && BANK_STATEMENT_STATUSES.includes(b.auditStatus)) d.auditStatus = b.auditStatus;
    if (b.notes !== undefined) d.notes = b.notes;
    if (b.statementFile !== undefined) d.statementFile = b.statementFile;
    await d.save();
    const out = await BankStatement.findById(d._id).populate("bankAccountId", "bankName accountNumber currency logo").populate("uploadedBy", "name avatar");
    return res.json(out);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

router.delete("/bank-statements/:id", canManage, async (req, res) => {
  try {
    const d = await BankStatement.findOneAndUpdate({ _id: req.params.id, organization: org(req) }, { $set: { isDeleted: true } }, { new: true });
    if (!d) return res.status(404).json({ message: "Statement not found" });
    return res.json({ ok: true, _id: d._id });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// ---------------- Audit center ----------------
async function ensureAuditItems(organization, period) {
  const existing = await AuditItem.find({ organization, period }).lean();
  const have = new Set(existing.map((i) => i.key));
  const missing = AUDIT_ITEMS.filter((i) => !have.has(i.key));
  if (missing.length) {
    await AuditItem.insertMany(missing.map((i) => ({ organization, period, key: i.key, label: i.label, category: i.category })));
  }
  return AuditItem.find({ organization, period }).sort({ createdAt: 1 }).lean();
}

router.get("/audit", async (req, res) => {
  try {
    const period = String(req.query.period || new Date().getFullYear());
    const rawItems = await ensureAuditItems(org(req), period);
    const auto = await auditAutoAvailability(org(req), period);
    const { items, stats } = applyAuditAuto(rawItems, auto);
    return res.json({ period, items, stats });
  } catch (err) {
    console.error("audit list error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/audit/:id", canManage, async (req, res) => {
  try {
    const item = await AuditItem.findOne({ _id: req.params.id, organization: org(req) });
    if (!item) return res.status(404).json({ message: "Item not found" });
    const b = req.body || {};
    if (b.status !== undefined && AUDIT_STATUSES.includes(b.status)) item.status = b.status;
    if (b.fileUrl !== undefined) { item.fileUrl = b.fileUrl; if (b.fileUrl && item.status === "missing") item.status = "uploaded"; }
    if (b.fileName !== undefined) item.fileName = b.fileName;
    if (b.notes !== undefined) item.notes = b.notes;
    item.updatedBy = req.user.id;
    await item.save();
    return res.json(item);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

module.exports = router;
