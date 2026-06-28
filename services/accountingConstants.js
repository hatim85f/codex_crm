// Shared accounting enums/constants — single source of truth for the backend
// (models + routes) and mirrored on the frontend in components/accounting/acctKit.js.

const EXPENSE_CATEGORIES = [
  "freelancer_salary", "software_subscription", "marketing", "cogs",
  "shipping", "courier_delivery", "office_expense", "payment_gateway_fees", "other",
];
const EXPENSE_STATUSES = ["pending", "approved", "paid", "rejected"];
const PAYMENT_METHODS = ["bank_transfer", "cash", "card", "online", "other"];

// Canonical business lines used across expenses, eCommerce profit and reports.
const BUSINESS_LINES = [
  "software_development", "software_maintenance", "client_ecommerce_management",
  "own_ecommerce_dropshipping", "own_ecommerce_imported_stock", "other",
];

const GATEWAY_PROVIDERS = ["stripe", "shopify_payments", "paypal", "other"];
const GATEWAY_STATUSES = ["uploaded", "reviewed", "matched", "failed"];
const ROW_MATCH_STATUSES = ["unmatched", "matched", "review"];

const BANK_STATEMENT_STATUSES = ["pending", "reviewed", "filed"];

const AUDIT_STATUSES = ["missing", "uploaded", "ready", "shared_with_auditor"];
// Default audit checklist (auto-seeded per organization + period).
const AUDIT_ITEMS = [
  { key: "sales_invoices", label: "Sales invoices", category: "Revenue" },
  { key: "payment_proofs", label: "Payment proofs", category: "Collections" },
  { key: "expense_receipts", label: "Expense receipts", category: "Payables" },
  { key: "bank_statements", label: "Bank statements", category: "Treasury" },
  { key: "pnl_report", label: "P&L report", category: "Financials" },
  { key: "trade_license", label: "Trade license", category: "Legal" },
  { key: "moa", label: "MOA", category: "Legal" },
  { key: "manager_id", label: "Manager EID / passport", category: "Identification" },
  { key: "previous_audit", label: "Previous audit report", category: "Compliance" },
];

module.exports = {
  EXPENSE_CATEGORIES, EXPENSE_STATUSES, PAYMENT_METHODS, BUSINESS_LINES,
  GATEWAY_PROVIDERS, GATEWAY_STATUSES, ROW_MATCH_STATUSES,
  BANK_STATEMENT_STATUSES, AUDIT_STATUSES, AUDIT_ITEMS,
};
