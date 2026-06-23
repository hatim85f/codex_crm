const express = require("express");

const router = express.Router();
const { getStripe } = require("../../services/stripe");
const Invoice = require("../../models/Invoice");
const Customer = require("../../models/Customer");
const { createNotifications } = require("../../services/notify");
const { roundMoney } = require("../../utils/documentTotals");

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

// Stripe webhook must receive the raw body for signature verification, so this
// router is mounted before express.json() in server.js.
router.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).send("Stripe not configured");

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch (e) {
    console.error("Stripe webhook signature error:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const invoiceId = session.metadata && session.metadata.invoiceId;
      if (invoiceId && session.payment_status === "paid") {
        const invoice = await Invoice.findById(invoiceId);
        // Checkout is always created for the full outstanding balance. Ignoring an
        // already-paid invoice makes Stripe webhook retries idempotent.
        if (invoice && invoice.status !== "paid" && Number(invoice.balance || 0) > 0) {
          const amount = roundMoney((session.amount_total || 0) / 100);
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
          if (invoice.status === "paid") await notifyInvoicePaid(invoice);
        }
      }
    }
    return res.json({ received: true });
  } catch (e) {
    console.error("Stripe webhook handler error:", e.message);
    return res.status(500).send("handler error");
  }
});

module.exports = router;
