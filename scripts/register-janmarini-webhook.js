// One-time setup: registers the Shopify -> Janmarini Tracking webhook so that
// marking an order fulfilled directly in Shopify admin also reflects here.
// Run this AFTER deploying to Heroku (needs a real public HTTPS callback URL) —
// pointless against localhost since Shopify can't reach it.
//   node scripts/register-janmarini-webhook.js
require("dotenv").config();
const { shopifyGraphQL } = require("../services/shopifyFulfillment");

const CALLBACK_URL = `${process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com"}/api/janmarini-webhooks/orders-fulfilled`;

const MUTATION = `
  mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id callbackUrl }
      userErrors { field message }
    }
  }
`;

(async () => {
  try {
    const data = await shopifyGraphQL(MUTATION, {
      topic: "ORDERS_FULFILLED",
      webhookSubscription: { uri: CALLBACK_URL, format: "JSON" },
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Failed:", e.message);
    process.exitCode = 1;
  }
})();
