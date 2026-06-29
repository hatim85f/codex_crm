const Customer = require("../models/Customer");
const { createNotifications } = require("./notify");
const { roundMoney } = require("../utils/documentTotals");

async function notifyInvoicePaid(invoice) {
  try {
    const customer = await Customer.findOne({
      _id: invoice.customerId,
      organization: invoice.organization,
    }).select("assignedTo");
    await createNotifications({
      organization: invoice.organization,
      recipientUserIds: [invoice.createdBy, customer?.assignedTo],
      audience: "internal",
      type: "invoice.paid",
      title: "Invoice paid",
      message: `Invoice ${invoice.invoiceNumber} is fully paid`,
      link: `invoices/${invoice._id}`,
      meta: { invoiceId: invoice._id, invoiceNumber: invoice.invoiceNumber },
    });
  } catch (e) {
    console.error("Stripe paid notification error:", e.message);
  }
}

async function applyStripePayment(invoice, session) {
  if (!invoice || !session || session.payment_status !== "paid") return invoice;
  if (invoice.status === "paid" || Number(invoice.balance || 0) <= 0) return invoice;

  const amount = roundMoney((session.amount_total || 0) / 100);
  if (!(amount > 0)) return invoice;

  invoice.paidAmount = roundMoney(Math.min(invoice.grandTotal, Number(invoice.paidAmount || 0) + amount));
  if (invoice.paidAmount >= invoice.grandTotal) {
    invoice.balance = 0;
    invoice.status = "paid";
    invoice.paidAt = invoice.paidAt || new Date();
  } else {
    invoice.balance = roundMoney(invoice.grandTotal - invoice.paidAmount);
    invoice.status = "partially_paid";
  }
  invoice.paymentMethod = "online_payment";
  invoice.paymentLink = "";
  invoice.history.push({ action: "invoice.payment_online", message: `Online payment received: ${amount}`, at: new Date() });
  await invoice.save();
  if (invoice.status === "paid") {
    await notifyInvoicePaid(invoice);
    try {
      const { fileReceipt } = require("./receipt");
      await fileReceipt(invoice, { amount: invoice.paidAmount, method: "online_payment", paidAt: invoice.paidAt });
    } catch (e) { console.error("receipt generation error:", e.message); }
  }
  return invoice;
}

module.exports = { applyStripePayment };
