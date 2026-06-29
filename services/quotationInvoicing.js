// On quotation approval, auto-create one invoice per payment slab (each = its
// share of the grand total + its agreed due date) and share them to the portal.
const Invoice = require("../models/Invoice");
const { roundMoney } = require("../utils/documentTotals");
const { nextInvoiceNumber } = require("../utils/documentNumbering");

const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };
const hist = (doc, action, message, userId) => {
  doc.history = doc.history || [];
  doc.history.push({ action, message, userId: userId || null, at: new Date() });
};

// Idempotent: skips entirely if the quotation already has invoices.
async function createSlabInvoices(quotation, userId) {
  const existing = await Invoice.countDocuments({ organization: quotation.organization, quotationId: quotation._id });
  if (existing > 0) return { created: 0, invoices: [] };

  let slabs = (quotation.paymentSchedule || []).filter((s) => Number(s.percentage) > 0);
  if (!slabs.length) slabs = [{ label: "Full payment", percentage: 100, dueDate: null }];

  const grand = roundMoney(quotation.grandTotal);
  const acceptDate = quotation.acceptedAt || new Date();
  const invoices = [];
  let allocated = 0;

  for (let i = 0; i < slabs.length; i++) {
    const slab = slabs[i];
    const isLast = i === slabs.length - 1;
    // Last slab absorbs rounding remainder so the invoices sum exactly to the total.
    const amount = isLast ? roundMoney(grand - allocated) : roundMoney(grand * (Number(slab.percentage) || 0) / 100);
    allocated = roundMoney(allocated + amount);
    if (amount <= 0) continue;

    const dueDate = slab.dueDate || addDays(acceptDate, i * 30); // agreed date, else +30 days per slab
    const label = slab.label || (slabs.length === 1 ? "Full payment" : `Installment ${i + 1}`);
    const invoiceNumber = await nextInvoiceNumber(Invoice, quotation.organization, quotation.customerId, acceptDate);

    const inv = new Invoice({
      organization: quotation.organization,
      invoiceNumber,
      customerId: quotation.customerId,
      contactId: quotation.contactId,
      quotationId: quotation._id,
      quotationSlabIndex: i,
      status: "sent",
      issueDate: acceptDate,
      dueDate,
      currency: quotation.currency,
      businessLine: quotation.businessLine,
      lineItems: [{
        serviceId: null,
        serviceName: `${label} — ${quotation.quotationNumber}`,
        description: `${slab.percentage ? `${slab.percentage}% of ` : ""}quotation ${quotation.quotationNumber} (total ${quotation.currency} ${grand})`,
        quantity: 1, unitLabel: "item", unitPrice: amount, currency: quotation.currency,
        taxable: false, taxRate: 0, billingType: "one_time", lineSubtotal: amount, taxAmount: 0, lineTotal: amount, sortOrder: 0,
      }],
      subtotal: amount, discountType: "none", discountValue: 0, discountAmount: 0, taxTotal: 0,
      grandTotal: amount, paidAmount: 0, balance: amount,
      bankAccountId: quotation.bankAccountId || null,
      notes: quotation.notes, terms: quotation.terms, internalNotes: quotation.internalNotes,
      sharedToPortal: true, sharedToPortalAt: new Date(), sentAt: new Date(),
      createdBy: userId, updatedBy: userId,
    });
    hist(inv, "invoice.created", `Auto-created from quotation ${quotation.quotationNumber} on approval (${label}, ${quotation.currency} ${amount})`, userId);
    await inv.save(); // save before the next so the number sequence increments
    invoices.push(inv);
  }

  quotation.status = "converted_to_invoice";
  quotation.convertedToInvoiceId = invoices[0]?._id || null;
  quotation.updatedBy = userId;
  hist(quotation, "quotation.invoice_created", `${invoices.length} invoice(s) auto-created on approval`, userId);
  await quotation.save();

  return { created: invoices.length, invoices };
}

module.exports = { createSlabInvoices };
