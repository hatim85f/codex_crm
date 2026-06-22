const express = require("express");

const router = express.Router();
const { getStripe } = require("../../services/stripe");
const Invoice = require("../../models/Invoice");
const { roundMoney } = require("../../utils/documentTotals");

// Stripe webhook — MUST receive the raw body for signature verification, so this
// router is mounted BEFORE express.json() in server.js.
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
        if (invoice) {
          const amount = roundMoney((session.amount_total || 0) / 100);
          invoice.paidAmount = roundMoney(Number(invoice.paidAmount || 0) + amount);
          if (invoice.paidAmount >= invoice.grandTotal) {
            invoice.balance = 0;
            invoice.status = "paid";
            invoice.paidAt = invoice.paidAt || new Date();
          } else {
            invoice.balance = roundMoney(invoice.grandTotal - invoice.paidAmount);
            invoice.status = "partially_paid";
          }
          invoice.paymentMethod = "online_payment";
          invoice.history.push({ action: "invoice.payment_online", message: `Online payment received: ${amount}`, at: new Date() });
          await invoice.save();
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
