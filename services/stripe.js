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

module.exports = { getStripe };
