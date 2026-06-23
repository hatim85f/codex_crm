// Lazy Stripe client. Reads STRIPE_SECRET_KEY from the environment (never hard-coded).
// Returns null when not configured so the app degrades gracefully.
let client = null;

function getStripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    client = require("stripe")(key);
    return client;
  } catch (e) {
    console.error("Stripe init failed:", e.message);
    return null;
  }
}

// Creates a Stripe Checkout Session for an invoice's outstanding balance. Returns the
// hosted payment URL, or null if Stripe isn't configured / nothing is due.
async function createInvoiceCheckoutUrl(invoice, webBaseUrl) {
  const stripe = getStripe();
  if (!stripe) return null;
  const round = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
  const amountDue = round(invoice.balance > 0 ? invoice.balance : invoice.grandTotal);
  if (amountDue <= 0) return null;
  const base = webBaseUrl || process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com";
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency: String(invoice.currency || "AED").toLowerCase(),
        product_data: { name: `Invoice ${invoice.invoiceNumber}` },
        unit_amount: Math.round(amountDue * 100),
      },
      quantity: 1,
    }],
    metadata: { invoiceId: String(invoice._id), invoiceNumber: invoice.invoiceNumber },
    success_url: `${base}/portal/invoices?paid=${invoice._id}`,
    cancel_url: `${base}/portal/invoices`,
  });
  return session.url;
}

module.exports = { getStripe, createInvoiceCheckoutUrl };
