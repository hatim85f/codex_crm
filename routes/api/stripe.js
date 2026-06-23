const express = require("express");

const router = express.Router();
const { getStripe } = require("../../services/stripe");
const { applyStripePayment } = require("../../services/invoicePayment");
const Invoice = require("../../models/Invoice");

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
        await applyStripePayment(invoice, session);
      }
    }
    return res.json({ received: true });
  } catch (e) {
    console.error("Stripe webhook handler error:", e.message);
    return res.status(500).send("handler error");
  }
});

module.exports = router;
