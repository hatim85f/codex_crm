const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Invoice = require("../../models/Invoice");
const Customer = require("../../models/Customer");
const CustomerContact = require("../../models/CustomerContact");
const User = require("../../models/User");
const Quotation = require("../../models/Quotation");
const Service = require("../../models/Service");
const BankAccount = require("../../models/BankAccount");
const { auth, requireRole } = require("../../middleware/auth");
const { calculateDocument, roundMoney } = require("../../utils/documentTotals");
const { createNotifications } = require("../../services/notify");
const { getStripe, createInvoiceCheckoutUrl } = require("../../services/stripe");
const { sendInvoicePortal } = require("../../services/emailService");
const webBase = () => process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com";
const { nextDocumentNumber, nextInvoiceNumber, ensureManualNumberAvailable } = require("../../utils/documentNumbering");

const VIEW = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"];
const STATUSES = ["draft", "sent", "partially_paid", "paid", "overdue", "cancelled", "pending_bank_verification"];
const BODY_FIELDS = ["invoiceNumber", "customerId", "contactId", "quotationId", "status", "issueDate", "dueDate", "currency", "businessLine", "discountType", "discountValue", "paidAmount", "paymentMethod", "paymentTerms", "depositAmount", "paymentLink", "bankAccountId", "bankTransferReceipt", "notes", "terms", "internalNotes", "pdfUrl", "emailSentAt", "lineItems"];

router.use(auth);
router.use(requireRole(...VIEW));

function addHistory(doc, action, message, req) {
  doc.history.push({ action, message, userId: req.user.id, at: new Date() });
}

function applyStatusTimestamps(doc, status) {
  if (status === "sent" && !doc.sentAt) doc.sentAt = new Date();
  if (status === "paid" && !doc.paidAt) doc.paidAt = new Date();
}

function buildListQuery(req) {
  const { search, status, customerId, dateFrom, dateTo, businessLine } = req.query;
  const query = { organization: req.user.organization };
  if (status) query.status = status;
  if (customerId) query.customerId = customerId;
  if (businessLine) query.businessLine = businessLine;
  if (search) query.invoiceNumber = new RegExp(String(search).trim(), "i");
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

async function validateOptionalRefs(req, bankAccountId, quotationId) {
  if (bankAccountId) {
    if (!mongoose.Types.ObjectId.isValid(bankAccountId)) throw new Error("Valid bankAccountId is required");
    const bank = await BankAccount.findById(bankAccountId).select("organization");
    if (!bank || String(bank.organization) !== String(req.user.organization)) throw new Error("Bank account not found");
  }
  if (quotationId) {
    if (!mongoose.Types.ObjectId.isValid(quotationId)) throw new Error("Valid quotationId is required");
    const quotation = await Quotation.findById(quotationId).select("organization status customerId");
    if (!quotation || String(quotation.organization) !== String(req.user.organization)) throw new Error("Quotation not found");
  }
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

function deriveInvoicePaymentState(grandTotal, paidAmount, explicitStatus) {
  const paid = Number(paidAmount || 0);
  if (paid < 0) throw new Error("paidAmount cannot be negative");
  const balance = paid >= grandTotal ? 0 : roundMoney(grandTotal - paid);
  let status = explicitStatus;
  if (paid >= grandTotal && grandTotal > 0) status = "paid";
  else if (paid > 0) status = "partially_paid";
  else if (!STATUSES.includes(status)) status = "draft";
  return { paidAmount: roundMoney(paid), balance, status };
}

async function preparePayload(req, body = {}, existingId = null) {
  if (!body.issueDate) throw new Error("issueDate is required");
  if (!body.currency) throw new Error("currency is required");
  if (!body.businessLine) throw new Error("businessLine is required");
  await validateCustomerAndContact(req, body.customerId, body.contactId);
  await validateOptionalRefs(req, body.bankAccountId, body.quotationId);
  if (body.invoiceNumber) await ensureManualNumberAvailable(Invoice, req.user.organization, "invoiceNumber", String(body.invoiceNumber).trim(), existingId);
  const hydratedItems = await hydrateLineItems(req, body.lineItems, body.currency);
  const totals = calculateDocument(hydratedItems, body.discountType, body.discountValue);
  const payment = deriveInvoicePaymentState(totals.grandTotal, body.paidAmount || 0, body.status);
  return {
    invoiceNumber: body.invoiceNumber ? String(body.invoiceNumber).trim() : undefined,
    customerId: body.customerId,
    contactId: body.contactId || null,
    quotationId: body.quotationId || null,
    status: payment.status,
    issueDate: body.issueDate,
    dueDate: body.dueDate || null,
    currency: body.currency,
    businessLine: String(body.businessLine).trim(),
    ...totals,
    paidAmount: payment.paidAmount,
    balance: payment.balance,
    paymentMethod: body.paymentMethod || "",
    paymentTerms: body.paymentTerms || "",
    depositAmount: Number(body.depositAmount || 0),
    paymentLink: body.paymentLink || "",
    bankAccountId: body.bankAccountId || null,
    bankTransferReceipt: body.bankTransferReceipt || "",
    notes: body.notes || "",
    terms: body.terms || "",
    internalNotes: body.internalNotes || "",
    pdfUrl: body.pdfUrl || "",
    emailSentAt: body.emailSentAt || null,
  };
}

async function notifyCustomerPortalUsers({ organization, customerId, type, title, message, link, meta }) {
  try {
    const users = await User.find({ organization, userType: "customer", customerId }).select("_id");
    await createNotifications({
      organization,
      recipientUserIds: users.map((u) => u._id),
      audience: "customer",
      type,
      title,
      message,
      link,
      meta,
    });
  } catch (e) {
    console.error("invoice customer notification error:", e.message);
  }
}

async function notifyInvoiceInternalUsers({ organization, invoice, type, title, message }) {
  try {
    const customer = await Customer.findOne({ _id: invoice.customerId, organization }).select("assignedTo");
    await createNotifications({
      organization,
      recipientUserIds: [invoice.createdBy, customer?.assignedTo],
      audience: "internal",
      type,
      title,
      message,
      link: `invoices/${invoice._id}`,
      meta: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber, customerId: invoice.customerId },
    });
  } catch (e) {
    console.error("invoice internal notification error:", e.message);
  }
}

function populateInvoice(query) {
  return query
    .populate("customerId", "displayName companyName email")
    .populate("contactId", "name email phone")
    .populate("quotationId", "quotationNumber status grandTotal")
    .populate("bankAccountId", "bankName accountHolderName accountNumber iban swift currency isPrimary")
    .populate("createdBy", "name email")
    .populate("updatedBy", "name email");
}

async function loadInvoice(req, res) {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice || String(invoice.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Invoice not found" });
    return null;
  }
  return invoice;
}

router.get("/", async (req, res) => {
  try {
    const invoices = await populateInvoice(Invoice.find(buildListQuery(req))).sort({ createdAt: -1 });
    return res.json(invoices);
  } catch (err) {
    console.error("list invoices error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const payload = await preparePayload(req, req.body || {});
    payload.invoiceNumber = payload.invoiceNumber || await nextInvoiceNumber(Invoice, req.user.organization, payload.customerId, payload.issueDate);
    const invoice = new Invoice({ ...payload, organization: req.user.organization, createdBy: req.user.id, updatedBy: req.user.id });
    applyStatusTimestamps(invoice, invoice.status);
    addHistory(invoice, "invoice.created", `Invoice ${invoice.invoiceNumber} created`, req);
    await invoice.save();
    await notifyCustomerPortalUsers({
      organization: req.user.organization,
      customerId: invoice.customerId,
      type: "invoice.created",
      title: "New invoice",
      message: `Invoice ${invoice.invoiceNumber} is available`,
      link: `invoices/${invoice._id}`,
      meta: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber },
    });
    const out = await populateInvoice(Invoice.findById(invoice._id));
    return res.status(201).json(out);
  } catch (err) {
    const code = err.status || (err.code === 11000 ? 409 : 400);
    if (code < 500) return res.status(code).json({ message: err.message || "Could not create invoice" });
    console.error("create invoice error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// Preview the next auto-generated invoice number for a customer (read-only, shown in the form).
router.get("/next-number", async (req, res) => {
  try {
    const { customerId, issueDate } = req.query;
    if (!customerId) return res.status(400).json({ message: "customerId is required" });
    const invoiceNumber = await nextInvoiceNumber(Invoice, req.user.organization, customerId, issueDate || new Date());
    return res.json({ invoiceNumber });
  } catch (err) {
    console.error("next invoice number error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const invoice = await populateInvoice(Invoice.findOne({ _id: req.params.id, organization: req.user.organization }));
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    return res.json(invoice);
  } catch (err) {
    console.error("get invoice error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    const body = req.body || {};
    const nextBody = {};
    BODY_FIELDS.forEach((field) => { if (body[field] !== undefined) nextBody[field] = body[field]; else nextBody[field] = invoice[field]; });
    nextBody.customerId = body.customerId !== undefined ? body.customerId : invoice.customerId;
    nextBody.contactId = body.contactId !== undefined ? body.contactId : invoice.contactId;
    nextBody.lineItems = body.lineItems !== undefined ? body.lineItems : invoice.lineItems.map((i) => i.toObject ? i.toObject() : i);
    const payload = await preparePayload(req, nextBody, invoice._id);
    if (body.status !== undefined) applyStatusTimestamps(invoice, payload.status);
    Object.assign(invoice, payload);
    if (invoice.status === "paid" && !invoice.paidAt) invoice.paidAt = new Date();
    invoice.updatedBy = req.user.id;
    addHistory(invoice, "invoice.updated", "Invoice updated", req);
    await invoice.save();
    const out = await populateInvoice(Invoice.findById(invoice._id));
    return res.json(out);
  } catch (err) {
    const code = err.status || (err.code === 11000 ? 409 : 400);
    return res.status(code).json({ message: err.message || "Could not update invoice" });
  }
});

router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ message: "Invalid invoice status" });
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    invoice.status = status;
    // "Mark as paid" should also settle the balance so it isn't paid-with-a-balance.
    if (status === "paid") {
      invoice.paidAmount = invoice.grandTotal;
      invoice.balance = 0;
      invoice.paidAt = invoice.paidAt || new Date();
    }
    invoice.updatedBy = req.user.id;
    applyStatusTimestamps(invoice, status);
    addHistory(invoice, "invoice.status", `Invoice marked ${status}`, req);
    await invoice.save();
    if (status === "sent") {
      await notifyCustomerPortalUsers({
        organization: req.user.organization,
        customerId: invoice.customerId,
        type: "invoice.sent",
        title: "Invoice sent",
        message: `Invoice ${invoice.invoiceNumber} is available`,
        link: `invoices/${invoice._id}`,
        meta: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber },
      });
    }
    const out = await populateInvoice(Invoice.findById(invoice._id));
    return res.json(out);
  } catch (err) {
    console.error("invoice status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/:id/record-payment", requireRole(...MANAGE), async (req, res) => {
  try {
    const amount = Number(req.body?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Payment amount must be greater than 0" });
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    const wasPaid = invoice.status === "paid";
    invoice.paidAmount = roundMoney(Number(invoice.paidAmount || 0) + amount);
    if (req.body?.paymentMethod !== undefined) invoice.paymentMethod = req.body.paymentMethod;
    if (req.body?.bankTransferReceipt !== undefined) invoice.bankTransferReceipt = req.body.bankTransferReceipt;
    if (invoice.paidAmount >= invoice.grandTotal) {
      invoice.balance = 0;
      invoice.status = "paid";
      invoice.paidAt = invoice.paidAt || new Date();
    } else {
      invoice.balance = roundMoney(invoice.grandTotal - invoice.paidAmount);
      invoice.status = "partially_paid";
    }
    invoice.updatedBy = req.user.id;
    addHistory(invoice, "invoice.payment_recorded", `Payment recorded: ${amount}`, req);
    await invoice.save();
    await notifyInvoiceInternalUsers({
      organization: req.user.organization,
      invoice,
      type: "invoice.payment_recorded",
      title: "Payment recorded",
      message: `Payment recorded for invoice ${invoice.invoiceNumber}`,
    });
    if (!wasPaid && invoice.status === "paid") {
      await notifyInvoiceInternalUsers({
        organization: req.user.organization,
        invoice,
        type: "invoice.paid",
        title: "Invoice paid",
        message: `Invoice ${invoice.invoiceNumber} is fully paid`,
      });
    }
    const out = await populateInvoice(Invoice.findById(invoice._id));
    return res.json(out);
  } catch (err) {
    console.error("record payment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/invoices/:id/payment-link — create a Stripe Checkout link for the balance.
router.post("/:id/payment-link", requireRole(...MANAGE), async (req, res) => {
  try {
    if (!getStripe()) return res.status(503).json({ message: "Stripe is not configured. Set STRIPE_SECRET_KEY on the server." });
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    const url = await createInvoiceCheckoutUrl(invoice, webBase());
    if (!url) return res.status(400).json({ message: "This invoice has nothing left to pay." });
    invoice.paymentLink = url;
    invoice.updatedBy = req.user.id;
    addHistory(invoice, "invoice.payment_link", "Payment link generated", req);
    await invoice.save();
    return res.json({ url });
  } catch (err) {
    console.error("payment link error:", err.message);
    return res.status(500).json({ message: err.message || "Could not create payment link" });
  }
});

// POST /api/invoices/:id/send  { portal, email }
// portal -> visible in the customer portal with a Pay Now button; email -> Brevo #10 with a payment link.
router.post("/:id/send", requireRole(...MANAGE), async (req, res) => {
  try {
    let { portal, email } = req.body || {};
    if (portal === undefined && email === undefined) { portal = true; email = true; }
    portal = !!portal; email = !!email;
    if (!portal && !email) return res.status(400).json({ message: "Choose portal, email, or both" });

    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    if (portal) { invoice.sharedToPortal = true; invoice.sharedToPortalAt = new Date(); }
    if (email) invoice.emailSentAt = new Date();
    if (invoice.status === "draft") { invoice.status = "sent"; if (!invoice.sentAt) invoice.sentAt = new Date(); }

    // Ensure we have a payment link (for the email + portal Pay Now).
    let paymentLink = invoice.paymentLink;
    if (!paymentLink && invoice.balance > 0) {
      try { paymentLink = await createInvoiceCheckoutUrl(invoice, webBase()); if (paymentLink) invoice.paymentLink = paymentLink; } catch (e) { /* non-fatal */ }
    }
    invoice.updatedBy = req.user.id;
    addHistory(invoice, "invoice.sent", `Invoice sent (${[portal && "portal", email && "email"].filter(Boolean).join(" + ")})`, req);
    await invoice.save();

    await notifyCustomerPortalUsers({
      organization: req.user.organization,
      customerId: invoice.customerId,
      type: "invoice.sent",
      title: "Invoice available",
      message: `Invoice ${invoice.invoiceNumber} is available to pay`,
      link: `invoices/${invoice._id}`,
      meta: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber },
    });

    let emailError = null;
    if (email) {
      const populated = await populateInvoice(Invoice.findById(invoice._id));
      const contact = populated.contactId;
      const customer = populated.customerId;
      const recipient = contact?.email || customer?.email;
      if (!recipient) emailError = "No email address found for this customer or contact.";
      else {
        const parts = String(contact?.name || customer?.displayName || "").trim().split(/\s+/);
        try {
          await sendInvoicePortal({
            email: recipient,
            firstName: parts[0] || "",
            lastName: parts.slice(1).join(" "),
            invoiceNumber: invoice.invoiceNumber,
            paymentLink: paymentLink || `${webBase()}/portal/invoices`,
          });
        } catch (e) { emailError = e.message || "Failed to send email"; }
      }
    }

    const out = await populateInvoice(Invoice.findById(invoice._id));
    return res.json({ invoice: out, emailError });
  } catch (err) {
    console.error("send invoice error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/invoices/:id
router.delete("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const invoice = await loadInvoice(req, res);
    if (!invoice) return;
    // detach from its quotation so the quotation can be re-invoiced
    if (invoice.quotationId) {
      try {
        const Quotation = require("../../models/Quotation");
        await Quotation.updateOne(
          { _id: invoice.quotationId, organization: req.user.organization, convertedToInvoiceId: invoice._id },
          { $set: { status: "accepted", convertedToInvoiceId: null } }
        );
      } catch (e) { /* best effort */ }
    }
    await invoice.deleteOne();
    return res.json({ ok: true, _id: invoice._id });
  } catch (err) {
    console.error("delete invoice error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

