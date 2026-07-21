// Fulfills a Shopify order via the Admin GraphQL API (client credentials grant,
// same "Janmarini Sync" app used for pulling orders). Used both by the
// employee-triggered "Mark fulfilled" action and to keep Shopify in sync when
// Aramex tracking becomes available.
const { getShopifyAccessToken, clearShopifyTokenCache } = require("./shopifyAuth");

async function shopifyGraphQL(query, variables, isRetry = false) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getShopifyAccessToken();
  if (!domain || !token) throw new Error("Shopify credentials not configured");

  const res = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  // 401 = cached token invalidated (e.g. new app version released with changed
  // scopes). Fetch a fresh token and retry once.
  if (res.status === 401 && !isRetry) {
    clearShopifyTokenCache();
    return shopifyGraphQL(query, variables, true);
  }
  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data;
}

// Needs only read_orders (always granted) — used to reflect Shopify's status
// before attempting any fulfillment write.
const ORDER_STATUS_QUERY = `
  query OrderStatus($id: ID!) {
    order(id: $id) { id displayFulfillmentStatus }
  }
`;

const FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 10) {
        edges {
          node {
            id
            status
            lineItems(first: 50) {
              edges { node { id remainingQuantity } }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// Fulfills every open fulfillment order/line item for a Shopify order (we
// don't do partial fulfillment — the employee marks the whole order packed).
// trackingNumber is optional (Aramex tracking, once known).
async function fulfillShopifyOrder(shopifyOrderId, trackingNumber) {
  // 1) Reflect Shopify first: if the order is already fulfilled there (e.g.
  // fulfilled directly in Shopify admin), we're done — no write needed. This
  // uses only read_orders, so it works regardless of fulfillment scopes.
  const statusData = await shopifyGraphQL(ORDER_STATUS_QUERY, { id: shopifyOrderId });
  if (!statusData.order) throw new Error(`Shopify order ${shopifyOrderId} not found`);
  if (statusData.order.displayFulfillmentStatus === "FULFILLED") {
    return { alreadyFulfilled: true };
  }

  // 2) Actually fulfill in Shopify — requires the fulfillment scopes on the
  // "Janmarini Sync" app. If they're missing, fail with a clear action item.
  let order;
  try {
    ({ order } = await shopifyGraphQL(FULFILLMENT_ORDERS_QUERY, { id: shopifyOrderId }));
  } catch (e) {
    if (String(e.message).includes("ACCESS_DENIED")) {
      throw new Error(
        'Shopify app "Janmarini Sync" is missing fulfillment permissions. In the Shopify Dev Dashboard, add scopes: read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, write_fulfillments — then retry.'
      );
    }
    throw e;
  }
  if (!order) throw new Error(`Shopify order ${shopifyOrderId} not found`);

  const openOrders = order.fulfillmentOrders.edges
    .map((e) => e.node)
    .filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS");

  if (!openOrders.length) return { alreadyFulfilled: true };

  const lineItemsByFulfillmentOrder = openOrders
    .filter((fo) => fo.lineItems.edges.some((e) => e.node.remainingQuantity > 0))
    .map((fo) => ({ fulfillmentOrderId: fo.id }));

  if (!lineItemsByFulfillmentOrder.length) return { alreadyFulfilled: true };

  const fulfillment = {
    lineItemsByFulfillmentOrder,
    notifyCustomer: true,
  };
  if (trackingNumber) {
    fulfillment.trackingInfo = { number: trackingNumber, company: "Aramex" };
  }

  let fulfillmentCreate;
  try {
    ({ fulfillmentCreate } = await shopifyGraphQL(FULFILLMENT_CREATE_MUTATION, { fulfillment }));
  } catch (e) {
    if (String(e.message).includes("ACCESS_DENIED")) {
      throw new Error(
        'Shopify app "Janmarini Sync" is missing fulfillment permissions. In the Shopify Dev Dashboard, add scopes: read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, write_fulfillments — then retry.'
      );
    }
    throw e;
  }
  if (fulfillmentCreate.userErrors?.length) {
    throw new Error(`Shopify fulfillment error: ${JSON.stringify(fulfillmentCreate.userErrors)}`);
  }
  return { alreadyFulfilled: false, fulfillment: fulfillmentCreate.fulfillment };
}

module.exports = { fulfillShopifyOrder, shopifyGraphQL };
