// Outbound (Dubai -> customer) Aramex delivery-status lookup.
//
// NOT WIRED UP YET: this account has no Aramex Shipping API credentials
// configured (see the earlier SOAP API review, deferred pending real
// credentials). Once ARAMEX_API_USERNAME/PASSWORD/ACCOUNT_NUMBER/PIN env vars
// exist, replace the body of checkOutboundTracking() with a real call to
// Aramex's Tracking.wsdl (TrackShipments) and this becomes live without any
// other code changing -- callers already treat a null/empty status as
// "not tracked yet", so wiring in a real answer here is the only step left.
function aramexCredentialsConfigured() {
  return !!(
    process.env.ARAMEX_API_USERNAME &&
    process.env.ARAMEX_API_PASSWORD &&
    process.env.ARAMEX_API_ACCOUNT_NUMBER &&
    process.env.ARAMEX_API_ACCOUNT_PIN
  );
}

// Returns { status, deliveredAt } or null if it can't be checked (no
// credentials configured, or the courier isn't Aramex). Never throws --
// tracking is a nice-to-have, not something that should break the caller.
async function checkOutboundTracking(courier, trackingNumber) {
  if (courier !== "Aramex" || !trackingNumber) return null;
  if (!aramexCredentialsConfigured()) return null;

  // TODO: real Aramex TrackShipments SOAP call once credentials exist.
  return null;
}

module.exports = { checkOutboundTracking, aramexCredentialsConfigured };
