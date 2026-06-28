const express = require("express");

const router = express.Router();
const Invoice = require("../../models/Invoice");
const Expense = require("../../models/Expense");
const BankStatement = require("../../models/BankStatement");
const AuditItem = require("../../models/AuditItem");
const { auth, requireRole } = require("../../middleware/auth");
const { computePnl } = require("../../services/accountingReports");

// Read-only audit area. The auditor role is limited to THIS router only — it is
// absent from every other route's role list, so it cannot reach CRM modules,
// leads, tasks, support, settings, etc. Admins/accountants may also view it.
const VIEW = ["auditor", "owner_admin", "admin", "accountant"];

router.use(auth);
router.use(requireRole(...VIEW));

const org = (req) => req.user.organization;

// Audit checklist documents (read-only).
router.get("/audit", async (req, res) => {
  try {
    const period = String(req.query.period || new Date().getFullYear());
    const items = await AuditItem.find({ organization: org(req), period }).sort({ createdAt: 1 });
    const total = items.length;
    const ready = items.filter((i) => ["ready", "shared_with_auditor"].includes(i.status)).length;
    return res.json({ period, items, stats: { total, ready, shared: items.filter((i) => i.status === "shared_with_auditor").length } });
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// Sales invoices + payment proofs (read-only).
router.get("/invoices", async (req, res) => {
  try {
    const q = { organization: org(req), status: { $ne: "cancelled" } };
    if (req.query.from || req.query.to) {
      q.issueDate = {};
      if (req.query.from) q.issueDate.$gte = new Date(req.query.from);
      if (req.query.to) q.issueDate.$lte = new Date(req.query.to);
    }
    const items = await Invoice.find(q)
      .select("invoiceNumber customerId issueDate dueDate currency businessLine grandTotal paidAmount balance status paymentMethod bankTransferReceipt pdfUrl")
      .populate("customerId", "displayName companyName").sort({ issueDate: -1 }).limit(500);
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// Expenses + receipts/proofs (read-only).
router.get("/expenses", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.from || req.query.to) {
      q.expenseDate = {};
      if (req.query.from) q.expenseDate.$gte = new Date(req.query.from);
      if (req.query.to) q.expenseDate.$lte = new Date(req.query.to);
    }
    const items = await Expense.find(q).sort({ expenseDate: -1 }).limit(500);
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// Bank statements (read-only).
router.get("/bank-statements", async (req, res) => {
  try {
    const q = { organization: org(req), isDeleted: false };
    if (req.query.year) q.year = Number(req.query.year);
    const items = await BankStatement.find(q).populate("bankAccountId", "bankName accountNumber currency logo").sort({ year: -1, month: -1 });
    return res.json(items);
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

// P&L report (read-only).
router.get("/pnl", async (req, res) => {
  try {
    return res.json(await computePnl(org(req), { from: req.query.from, to: req.query.to, businessLine: req.query.businessLine }));
  } catch (err) { return res.status(500).json({ message: "Server error" }); }
});

module.exports = router;
