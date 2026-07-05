// Deterministic, no-judgment-calls sync work — safe to run unattended on a daily
// Heroku Scheduler job. Anything requiring matching/interpretation (receipts →
// orders, ambiguous items) is deliberately left for the Claude review pass:
// see PendingReceipt / open flags in JANMARINI_FULFILLMENT.md.
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const InboundShipment = require("../models/janmarini/InboundShipment");
const PendingReceipt = require("../models/janmarini/PendingReceipt");
const { fetchUnseenReceipts, getConfiguredMailboxes } = require("./janmariniMailbox");
const { getShopifyAccessToken } = require("./shopifyAuth");

const IGNORED_ORDER_NUMBERS = ["#1760", "#1761", "#1762"];

// Real orders only start Jun 20 (per JANMARINI_FULFILLMENT.md) — everything
// before that is unrelated store history, not worth syncing. Override via env
// if the cutoff ever needs to move.
const ORDERS_SINCE = process.env.SHOPIFY_ORDERS_SINCE || "2026-06-20";

const ORDERS_QUERY = `
  query FulfillmentOrders($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      edges {
        cursor
        node {
          id
          name
          createdAt
          phone
          customer { firstName lastName }
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 50) {
            edges {
              node {
                name
                quantity
                image { url }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

// Pulls orders since ORDERS_SINCE from the Shopify Admin GraphQL API (gives us
// line-item images + order total in one round trip) and upserts them. Requires
// SHOPIFY_STORE_DOMAIN plus SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET (the
// "Janmarini Sync" Dev Dashboard app, installed on this store, using the client
// credentials grant) — separate from the MCP connector used in chat.
async function syncShopifyOrders() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getShopifyAccessToken();
  if (!domain || !token) {
    console.warn("[janmarini] Skipping Shopify sync — SHOPIFY_STORE_DOMAIN/SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET not set");
    return { synced: 0, skipped: true };
  }

  let synced = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const res = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({
        query: ORDERS_QUERY,
        variables: { query: `created_at:>=${ORDERS_SINCE}`, cursor },
      }),
    });
    if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);

    const { edges, pageInfo } = body.data.orders;
    for (const { node: o } of edges) {
      const orderNumber = o.name; // already "#1750"-style
      const money = o.totalPriceSet?.shopMoney;
      await ShopifyOrder.findOneAndUpdate(
        { shopifyOrderId: o.id },
        {
          shopifyOrderId: o.id,
          orderNumber,
          customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" "),
          customerPhone: o.phone || "",
          orderDate: o.createdAt ? new Date(o.createdAt) : null,
          totalPrice: Number(money?.amount) || 0,
          currency: money?.currencyCode || "AED",
          ignored: IGNORED_ORDER_NUMBERS.includes(orderNumber),
          items: o.lineItems.edges.map(({ node: li }) => ({
            name: li.name,
            quantity: li.quantity,
            image: li.image?.url || "",
          })),
        },
        { upsert: true, new: true }
      );
      synced += 1;
    }
    hasNextPage = pageInfo.hasNextPage;
    cursor = edges[edges.length - 1]?.cursor || null;
  }

  return { synced, skipped: false };
}

// Stages new mail from every configured inbox (mariniorders, eBay via Gmail,
// Shop & Ship via info@) for the Claude review pass — does NOT try to match them.
async function syncMailboxReceipts() {
  const configured = getConfiguredMailboxes();
  if (!configured.length) {
    console.warn("[janmarini] Skipping mailbox sync — no mailboxes configured");
    return { staged: 0, skipped: true };
  }

  const { messages, errors, mailboxesChecked } = await fetchUnseenReceipts();
  for (const m of messages) {
    if (m.messageId && (await PendingReceipt.exists({ source: m.source, messageId: m.messageId }))) continue;
    await PendingReceipt.create({
      source: m.source,
      messageUid: m.messageUid,
      messageId: m.messageId,
      subject: m.subject,
      from: m.from,
      receivedAt: m.date,
      bodyText: m.bodyText,
      attachments: m.attachments,
    });
  }
  if (errors.length) console.warn("[janmarini] Mailbox errors:", JSON.stringify(errors));
  return { staged: messages.length, skipped: false, mailboxesChecked, errors };
}

// TODO: Aramex/Shop & Ship has no confirmed public tracking API wired up yet —
// once we have API credentials, poll here for every InboundShipment not yet
// "Delivered-to-office" and update `status` + `lastTrackingCheck`.
async function syncAramexTracking() {
  const pending = await InboundShipment.find({ status: { $ne: "Delivered-to-office" } }).select("_id");
  console.warn(`[janmarini] Aramex tracking sync not yet implemented — ${pending.length} shipment(s) awaiting status`);
  return { checked: 0, skipped: true, pendingCount: pending.length };
}

async function runDailySync() {
  const shopify = await syncShopifyOrders().catch((e) => ({ error: e.message }));
  const mailbox = await syncMailboxReceipts().catch((e) => ({ error: e.message }));
  const aramex = await syncAramexTracking().catch((e) => ({ error: e.message }));
  return { shopify, mailbox, aramex };
}

module.exports = { runDailySync, syncShopifyOrders, syncMailboxReceipts, syncAramexTracking };
