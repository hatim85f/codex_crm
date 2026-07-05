// Client credentials grant for the "Janmarini Sync" Dev Dashboard app — this app
// only ever runs against our own store, so no OAuth redirect/install-flow dance is
// needed, just exchange the client id/secret for a short-lived token each time.
// Tokens last 24h; cached in-memory and refreshed a minute before expiry.
let cached = null; // { token, expiresAt }

async function getShopifyAccessToken() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;

  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

module.exports = { getShopifyAccessToken };
