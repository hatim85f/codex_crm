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
  ensureManualNumberAvailable,
};
