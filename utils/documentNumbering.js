function yearPrefix(prefix, date = new Date()) {
  const year = new Date(date).getFullYear();
  return `${prefix}-${year}-`;
}

async function nextDocumentNumber(Model, organization, prefix, fieldName, date = new Date()) {
  const start = yearPrefix(prefix, date);
  const latest = await Model.findOne({ organization, [fieldName]: new RegExp(`^${start}\\d+$`) })
    .sort({ [fieldName]: -1 })
    .select(fieldName)
    .lean();
  const current = latest?.[fieldName] || "";
  const lastSeq = Number(current.slice(start.length)) || 0;
  return `${start}${String(lastSeq + 1).padStart(4, "0")}`;
}

// Continuous quotation numbering (no year reset). Floors at `base` so the first
// created quotation is base+1 (default 150 -> first is QUO-151). Parses the numeric
// suffix instead of relying on string sort, so it stays correct past 999/9999.
async function nextQuotationNumber(Model, organization, base = 150) {
  const docs = await Model.find({ organization, quotationNumber: /^QUO-\d+$/i })
    .select("quotationNumber")
    .lean();
  let max = base;
  for (const d of docs) {
    const n = Number(String(d.quotationNumber).replace(/^QUO-/i, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `QUO-${max + 1}`;
}

function yymmdd(date = new Date()) {
  const d = new Date(date);
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  const yy = String(valid.getFullYear()).slice(-2);
  const mm = String(valid.getMonth() + 1).padStart(2, "0");
  const dd = String(valid.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Invoice numbering: YYMMDD-<last 4 of customer id>-<running number>  e.g. 250620-bc2c-204
// The running number is global across all new-format invoices (max trailing segment + 1).
async function nextInvoiceNumber(Model, organization, customerId, date = new Date(), base = 0) {
  const last4 = String(customerId || "").slice(-4) || "0000";
  const datePart = yymmdd(date);
  const docs = await Model.find({ organization, invoiceNumber: /^\d{6}-[0-9a-zA-Z]{1,12}-\d+$/ })
    .select("invoiceNumber")
    .lean();
  let max = base;
  for (const d of docs) {
    const m = String(d.invoiceNumber).match(/-(\d+)$/);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${datePart}-${last4}-${max + 1}`;
}

async function ensureManualNumberAvailable(Model, organization, fieldName, value, existingId = null) {
  if (!value) return;
  const found = await Model.findOne({ organization, [fieldName]: value }).select("_id").lean();
  if (found && (!existingId || String(found._id) !== String(existingId))) {
    const label = fieldName === "invoiceNumber" ? "invoice" : "quotation";
    const err = new Error(`A ${label} with this number already exists`);
    err.status = 409;
    throw err;
  }
}

module.exports = {
  nextDocumentNumber,
  nextQuotationNumber,
  nextInvoiceNumber,
  ensureManualNumberAvailable,
};
