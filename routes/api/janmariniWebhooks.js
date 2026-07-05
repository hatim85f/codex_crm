// Shopify webhook receiver — keeps the tracker in sync when an order is
// fulfilled directly in Shopify admin (rather than via the employee's "Mark
// fulfilled" action here). Mounted before express.json() in server.js since
// HMAC verification needs the raw body.
const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const ShopifyOrder = require("../../models/janmarini/ShopifyOrder");
const Purchase = require("../../models/janmarini/Purchase");

function verifyShopifyWebhook(req) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const hmacHeader = req.header("X-Shopify-Hmac-Sha256");
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.body).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

router.post("/orders-fulfilled", express.raw({ type: "*/*" }), async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send("Invalid signature");

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    return res.status(400).send("Invalid JSON");
  }

  try {
    const shopifyOrderId = `gid://shopify/Order/${payload.id}`;
    const order = await ShopifyOrder.findOneAndUpdate(
      { shopifyOrderId },
      { fulfilled: true, fulfilledAt: new Date() },
      { new: true }
    );
    if (order) {
      await Purchase.updateMany({ orderNumber: order.orderNumber }, { status: "delivered" });
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("[janmarini] orders-fulfilled webhook error:", e.message);
    res.status(500).send("error");
  }
});

module.exports = router;
