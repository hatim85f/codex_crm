const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Quotation = require("../../models/Quotation");
const Invoice = require("../../models/Invoice");
const Customer = require("../../models/Customer");
const CustomerContact = require("../../models/CustomerContact");
const Service = require("../../models/Service");
const BankAccount = require("../../models/BankAccount");
const { auth, requireRole } = require("../../middleware/auth");
const { sendQuotationPortal } = require("../../services/emailService");
const { calculateDocument, roundMoney } = require("../../utils/documentTotals");
const { nextDocumentNumber, nextQuotationNumber, nextInvoiceNumber, ensureManualNumberAvailable } = require("../../utils/documentNumbering");

const VIEW = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
// Only managers (owner_admin), admins, and team leaders can create/edit/send quotations.
const MANAGE = ["owner_admin", "admin", "team_leader"];
const DELETE_ROLES = ["owner_admin", "admin"];
const STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "cancelled", "converted_to_invoice"];
const BODY_FIELDS = ["quotationNumber", "customerId", "contactId", "status", "issueDate", "validUntil", "currency", "businessLine", "discountType", "discountValue", "notes", "terms", "termsAndConditions", "scopeItems", "timeline", "paymentSchedule", "bankAccountId", "internalNotes", "pdfUrl", "emailSentAt", "lineItems"];

function sanitizeScope(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => ({
      text: String((it && it.text) || "").trim(),
      children: (it && Array.isArray(it.children) ? it.children : []).map((c) => String(c || "").trim()).filter(Boolean),
    }))
    .filter((it) => it.text);
}

function sanitizeSchedule(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => ({
      label: String((s && s.label) || "").trim(),
      percentage: Math.max(0, Math.min(100, Number((s && s.percentage)) || 0)),
    }))
    .filter((s) => s.label || s.percentage);
}

// Terms are copied (not referenced) into the quotation so they are frozen at save time.
function sanitizeTerms(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t, i) => ({
      termId: t && t.termId && mongoose.Types.ObjectId.isValid(t.termId) ? t.termId : null,
      title: String((t && t.title) || "").trim(),
      body: String((t && t.body) || ""),
      category: (t && t.category) || "general",
      sortOrder: t && t.sortOrder !== undefined ? Number(t.sortOrder) : i,
    }))
    .filter((t) => t.title);
}

function defaultValidUntil(issueDate) {
  const d = new Date(issueDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 7);
  return d;
}

router.use(auth);
router.use(requireRole(...VIEW));

function addHistory(doc, action, message, req) {
  doc.history.push({ action, message, userId: req.user.id, at: new Date() });
}

function applyStatusTimestamps(doc, status) {
  if (status === "sent" && !doc.sentAt) doc.sentAt = new Date();
  if (status === "accepted" && !doc.acceptedAt) doc.acceptedAt = new Date();
  if (status === "rejected" && !doc.rejectedAt) doc.rejectedAt = new Date();
}

function buildListQuery(req) {
  const { search, status, customerId, dateFrom, dateTo, businessLine } = req.query;
  const query = { organization: req.user.organization };
  if (status) query.status = status;
  if (customerId) query.customerId = customerId;
  if (businessLine) query.businessLine = businessLine;
  if (search) query.quotationNumber = new RegExp(String(search).trim(), "i");
  if (dateFrom || dateTo) {
    query.issueDate = {};
    if (dateFrom) query.issueDate.$gte = new Date(dateFrom);
    if (dateTo) query.issueDate.$lte = new Date(dateTo);
  }
  return query;
}

async function validateCustomerAndContact(req, customerId, contactId) {
  if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) throw new Error("Valid customerId is required");
  const customer = await Customer.findById(customerId).select("organization displayName");
  if (!customer || String(customer.organization) !== String(req.user.organization)) throw new Error("Customer not found");
  if (contactId) {
    if (!mongoose.Types.ObjectId.isValid(contactId)) throw new Error("Valid contactId is required");
    const contact = await CustomerContact.findById(contactId).select("organization customerId name");
    if (!contact || String(contact.organization) !== String(req.user.organization) || String(contact.customerId) !== String(customer._id)) {
      throw new Error("Contact must belong to the selected customer");
    }
  }
  return customer;
}

async function hydrateLineItems(req, rawItems = [], documentCurrency = "AED") {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new Error("At least one line item is required");
  const hydrated = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i] || {};
    let service = null;
    if (item.serviceId) {
      if (!mongoose.Types.ObjectId.isValid(item.serviceId)) throw new Error("Invalid serviceId in line item");
      service = await Service.findById(item.serviceId);
      if (!service || String(service.organization) !== String(req.user.organization)) throw new Error("Line item service not found");
    }
    const merged = {
      serviceId: service?._id || item.serviceId || null,
      serviceName: item.serviceName || service?.serviceName || "",
      description: item.description !== undefined ? item.description : service?.description || "",
      quantity: item.quantity !== undefined ? item.quantity : service?.defaultQuantity || 1,
      unitLabel: item.unitLabel || service?.unitLabel || "unit",
      unitPrice: item.unitPrice !== undefined ? item.unitPrice : service?.defaultPrice || 0,
      currency: item.currency || service?.currency || documentCurrency,
      taxable: item.taxable !== undefined ? item.taxable : service ? service.taxable : true,
      taxRate: item.taxRate !== undefined ? item.taxRate : service ? service.taxRate : 0,
      billingType: item.billingType || service?.billingType || "one_time",
      sortOrder: item.sortOrder !== undefined ? item.sortOrder : i,
    };
    if (!merged.serviceName) throw new Error("Line item serviceName is required");
    hydrated.push(merged);
  }
  return hydrated;
}

async function preparePayload(req, body = {}, existingId = null) {
  if (!body.issueDate) throw new Error("issueDate is required");
  if (!body.currency) throw new Error("currency is required");
  if (!body.businessLine) throw new Error("businessLine is required");
  await validateCustomerAndContact(req, body.customerId, body.contactId);
  let bankAccountId = null;
  if (body.bankAccountId) {
    if (!mongoose.Types.ObjectId.isValid(body.bankAccountId)) throw new Error("Valid bankAccountId is required");
    const bank = await BankAccount.findById(body.bankAccountId).select("organization");
    if (!bank || String(bank.organization) !== String(req.user.organization)) throw new Error("Bank account not found");
    bankAccountId = body.bankAccountId;
  }
  if (body.quotationNumber) await ensureManualNumberAvailable(Quotation, req.user.organization, "quotationNumber", String(body.quotationNumber).trim(), existingId);
  const hydratedItems = await hydrateLineItems(req, body.lineItems, body.currency);
  const totals = calculateDocument(hydratedItems, body.discountType, body.discountValue);
  return {
    quotationNumber: body.quotationNumber ? String(body.quotationNumber).trim() : undefined,
    customerId: body.customerId,
    contactId: body.contactId || null,
    status: STATUSES.includes(body.status) ? body.status : "draft",
    issueDate: body.issueDate,
    validUntil: body.validUntil || defaultValidUntil(body.issueDate),
    currency: body.currency,
    businessLine: String(body.businessLine).trim(),
    ...totals,
    notes: body.notes || "",
    terms: body.terms || "",
    termsAndConditions: sanitizeTerms(body.termsAndConditions),
    scopeItems: sanitizeScope(body.scopeItems),
    timeline: body.timeline ? String(body.timeline).trim() : "",
    paymentSchedule: sanitizeSchedule(body.paymentSchedule),
    bankAccountId,
    internalNotes: body.internalNotes || "",
    pdfUrl: body.pdfUrl || "",
    emailSentAt: body.emailSentAt || null,
  };
}

const webBase = () => process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com";

function populateQuotation(query) {
  return query
    .populate({ path: "customerId", select: "displayName companyName email phone tax assignedTo", populate: { path: "assignedTo", select: "name phone email" } })
    .populate("contactId", "name email phone")
    .populate("bankAccountId", "bankName accountHolderName accountNumber iban swift currency isPrimary logo branch")
    .populate("createdBy", "name email")
    .populate("updatedBy", "name email")
    .populate("convertedToInvoiceId", "invoiceNumber status grandTotal balance");
}

async function loadQuotation(req, res) {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || String(quotation.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Quotation not found" });
    return null;
  }
  return quotation;
}

router.get("/", async (req, res) => {
  try {
    const quotations = await populateQuotation(Quotation.find(buildListQuery(req))).sort({ createdAt: -1 });
    return res.json(quotations);
  } catch (err) {
    console.error("list quotations error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const payload = await preparePayload(req, req.body || {});
    payload.quotationNumber = payload.quotationNumber || await nextQuotationNumber(Quotation, req.user.organization);
    const quotation = new Quotation({ ...payload, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    applyStatusTimestamps(quotation, quotation.status);
    addHistory(quotation, "quotation.created", `Quotation ${quotation.quotationNumber} created`, req);
    await quotation.save();
    const out = await populateQuotation(Quotation.findById(quotation._id));
    return res.status(201).json(out);
  } catch (err) {
    const code = err.status || (err.code === 11000 ? 409 : 400);
    if (code < 500) return res.status(code).json({ message: err.message || "Could not create quotation" });
    console.error("create quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Preview the next auto-generated quotation number (read-only, shown in the form).
router.get("/next-number", async (req, res) => {
  try {
    const quotationNumber = await nextQuotationNumber(Quotation, req.user.organization);
    return res.json({ quotationNumber });
  } catch (err) {
    console.error("next quotation number error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const quotation = await populateQuotation(Quotation.findOne({ _id: req.params.id, organization: req.user.organization }));
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });
    return res.json(quotation);
  } catch (err) {
    console.error("get quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const quotation = await loadQuotation(req, res);
    if (!quotation) return;
    const body = req.body || {};
    const nextBody = {};
    BODY_FIELDS.forEach((field) => { if (body[field] !== undefined) nextBody[field] = body[field]; else nextBody[field] = quotation[field]; });
    nextBody.customerId = body.customerId !== undefined ? body.customerId : quotation.customerId;
    nextBody.contactId = body.contactId !== undefined ? body.contactId : quotation.contactId;
    nextBody.lineItems = body.lineItems !== undefined ? body.lineItems : quotation.lineItems.map((i) => i.toObject ? i.toObject() : i);
    const payload = await preparePayload(req, nextBody, quotation._id);
    if (body.status !== undefined) applyStatusTimestamps(quotation, payload.status);
    Object.assign(quotation, payload);
    quotation.updatedBy = req.user.id;
    addHistory(quotation, "quotation.updated", "Quotation updated", req);
    await quotation.save();
    const out = await populateQuotation(Quotation.findById(quotation._id));
    return res.json(out);
  } catch (err) {
    const code = err.status || (err.code === 11000 ? 409 : 400);
    return res.status(code).json({ message: err.message || "Could not update quotation" });
  }
});

router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ message: "Invalid quotation status" });
    const quotation = await loadQuotation(req, res);
    if (!quotation) return;
    quotation.status = status;
    quotation.updatedBy = req.user.id;
    applyStatusTimestamps(quotation, status);
    addHistory(quotation, "quotation.status", `Quotation marked ${status}`, req);
    await quotation.save();
    const out = await populateQuotation(Quotation.findById(quotation._id));
    return res.json(out);
  } catch (err) {
    console.error("quotation status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/quotations/:id/send  { portal, email }
// portal -> make it visible in the customer portal; email -> send Brevo template #9.
// Omit both -> sends to both. Returns the quotation plus any email error (non-fatal).
router.post("/:id/send", requireRole(...MANAGE), async (req, res) => {
  try {
    let { portal, email } = req.body || {};
    if (portal === undefined && email === undefined) { portal = true; email = true; }
    portal = !!portal; email = !!email;
    if (!portal && !email) return res.status(400).json({ message: "Choose portal, email, or both" });

    const quotation = await loadQuotation(req, res);
    if (!quotation) return;
    if (portal) { quotation.sharedToPortal = true; quotation.sharedToPortalAt = new Date(); }
    if (email) { quotation.emailSentAt = new Date(); }
    if (quotation.status === "draft") { quotation.status = "sent"; if (!quotation.sentAt) quotation.sentAt = new Date(); }
    quotation.updatedBy = req.user.id;
    const channels = [portal && "portal", email && "email"].filter(Boolean).join(" + ");
    addHistory(quotation, "quotation.sent", `Quotation sent (${channels})`, req);
    await quotation.save();

    let emailError = null;
    if (email) {
      const populated = await populateQuotation(Quotation.findById(quotation._id));
      const contact = populated.contactId;
      const customer = populated.customerId;
      const recipient = contact?.email || customer?.email;
      if (!recipient) {
        emailError = "No email address found for this customer or contact.";
      } else {
        const parts = String(contact?.name || customer?.displayName || "").trim().split(/\s+/);
        const assignee = customer?.assignedTo;
        try {
          await sendQuotationPortal({
            email: recipient,
            firstName: parts[0] || "",
            lastName: parts.slice(1).join(" "),
            assignedPerso: assignee?.name,
            assigneePhone: assignee?.phone,
            fileLink: quotation.pdfUrl || `${webBase()}/portal`,
          });
        } catch (e) {
          emailError = e.message || "Failed to send email";
        }
      }
    }

    const out = await populateQuotation(Quotation.findById(quotation._id));
    return res.json({ quotation: out, emailError });
  } catch (err) {
    console.error("send quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/:id/duplicate", requireRole(...MANAGE), async (req, res) => {
  try {
    const source = await loadQuotation(req, res);
    if (!source) return;
    const quotationNumber = await nextQuotationNumber(Quotation, req.user.organization);
    const duplicate = new Quotation({
      organization: req.user.organization,
      quotationNumber,
      customerId: source.customerId,
      contactId: source.contactId,
      status: "draft",
      issueDate: new Date(),
      validUntil: source.validUntil,
      currency: source.currency,
      businessLine: source.businessLine,
      lineItems: source.lineItems.map((item) => item.toObject ? item.toObject() : item),
      subtotal: source.subtotal,
      discountType: source.discountType,
      discountValue: source.discountValue,
      discountAmount: source.discountAmount,
      taxTotal: source.taxTotal,
      grandTotal: source.grandTotal,
      notes: source.notes,
      terms: source.terms,
      termsAndConditions: source.termsAndConditions.map((t) => (t.toObject ? t.toObject() : t)),
      scopeItems: source.scopeItems.map((s) => (s.toObject ? s.toObject() : s)),
      timeline: source.timeline,
      paymentSchedule: source.paymentSchedule.map((s) => (s.toObject ? s.toObject() : s)),
      bankAccountId: source.bankAccountId,
      internalNotes: source.internalNotes,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    addHistory(duplicate, "quotation.duplicated", `Duplicated from ${source.quotationNumber}`, req);
    source.updatedBy = req.user.id;
    addHistory(source, "quotation.duplicated", `Duplicated into ${quotationNumber}`, req);
    await duplicate.save();
    await source.save();
    const out = await populateQuotation(Quotation.findById(duplicate._id));
    return res.status(201).json(out);
  } catch (err) {
    console.error("duplicate quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/:id/create-invoice", requireRole("owner_admin", "admin"), async (req, res) => {
  try {
    const quotation = await loadQuotation(req, res);
    if (!quotation) return;
    if (quotation.status !== "accepted") return res.status(400).json({ message: "Only accepted quotations can be converted to invoices" });
    if (quotation.convertedToInvoiceId) return res.status(409).json({ message: "Quotation already has an invoice" });
    const invoiceNumber = req.body?.invoiceNumber
      ? String(req.body.invoiceNumber).trim()
      : await nextInvoiceNumber(Invoice, req.user.organization, quotation.customerId, req.body?.issueDate || new Date());
    await ensureManualNumberAvailable(Invoice, req.user.organization, "invoiceNumber", invoiceNumber);
    if (req.body?.status && !["draft", "sent", "partially_paid", "paid", "overdue", "cancelled", "pending_bank_verification"].includes(req.body.status)) {
      return res.status(400).json({ message: "Invalid invoice status" });
    }
    if (req.body?.bankAccountId) {
      if (!mongoose.Types.ObjectId.isValid(req.body.bankAccountId)) return res.status(400).json({ message: "Valid bankAccountId is required" });
      const bank = await BankAccount.findById(req.body.bankAccountId).select("organization");
      if (!bank || String(bank.organization) !== String(req.user.organization)) return res.status(400).json({ message: "Bank account not found" });
    }
    const paidAmount = Number(req.body?.paidAmount || 0);
    if (paidAmount < 0) return res.status(400).json({ message: "paidAmount cannot be negative" });
    const balance = roundMoney(Math.max(0, quotation.grandTotal - paidAmount));
    const invoice = new Invoice({
      organization: req.user.organization,
      invoiceNumber,
      customerId: quotation.customerId,
      contactId: quotation.contactId,
      quotationId: quotation._id,
      status: paidAmount >= quotation.grandTotal && quotation.grandTotal > 0 ? "paid" : req.body?.status || "draft",
      issueDate: req.body?.issueDate || new Date(),
      dueDate: req.body?.dueDate || null,
      currency: quotation.currency,
      businessLine: quotation.businessLine,
      lineItems: quotation.lineItems.map((item) => item.toObject ? item.toObject() : item),
      subtotal: quotation.subtotal,
      discountType: quotation.discountType,
      discountValue: quotation.discountValue,
      discountAmount: quotation.discountAmount,
      taxTotal: quotation.taxTotal,
      grandTotal: quotation.grandTotal,
      paidAmount,
      balance,
      paymentMethod: req.body?.paymentMethod || "",
      paymentTerms: req.body?.paymentTerms || "",
      depositAmount: Number(req.body?.depositAmount || 0),
      paymentLink: req.body?.paymentLink || "",
      bankAccountId: req.body?.bankAccountId || null,
      bankTransferReceipt: req.body?.bankTransferReceipt || "",
      notes: req.body?.notes || quotation.notes,
      terms: req.body?.terms || quotation.terms,
      internalNotes: req.body?.internalNotes || quotation.internalNotes,
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });
    if (invoice.status === "paid") invoice.paidAt = new Date();
    addHistory(invoice, "invoice.created", `Invoice ${invoice.invoiceNumber} created from quotation ${quotation.quotationNumber}`, req);
    quotation.status = "converted_to_invoice";
    quotation.convertedToInvoiceId = invoice._id;
    quotation.updatedBy = req.user.id;
    addHistory(quotation, "quotation.invoice_created", `Invoice ${invoice.invoiceNumber} created`, req);
    await invoice.save();
    await quotation.save();
    const out = await Invoice.findById(invoice._id)
      .populate("customerId", "displayName companyName email")
      .populate("contactId", "name email phone")
      .populate("quotationId", "quotationNumber status grandTotal")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    return res.status(201).json(out);
  } catch (err) {
    const code = err.status || (err.code === 11000 ? 409 : 500);
    if (code < 500) return res.status(code).json({ message: err.message });
    console.error("create invoice from quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/quotations/:id — removing it here also removes it from the customer
// portal (the portal only lists existing shared quotations).
router.delete("/:id", requireRole(...DELETE_ROLES), async (req, res) => {
  try {
    const quotation = await loadQuotation(req, res);
    if (!quotation) return;
    if (quotation.convertedToInvoiceId) {
      return res.status(409).json({ message: "This quotation has an invoice. Delete the invoice first." });
    }
    await quotation.deleteOne();
    return res.json({ ok: true, _id: quotation._id });
  } catch (err) {
    console.error("delete quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

