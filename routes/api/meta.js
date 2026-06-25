const express = require("express");
const crypto = require("crypto");

const router = express.Router();

// This router is mounted BEFORE express.json() in server.js so we get the raw
// request body — Meta signs the raw bytes (X-Hub-Signature-256), same as Stripe.
router.use(express.raw({ type: "*/*" }));

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN || "";
const APP_SECRET = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || "";

// GET /api/meta/webhook -> verification handshake (Meta calls this once when you
// save the callback URL). Echo hub.challenge only if the verify token matches.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Verify the payload signature against the app secret.
function verifySignature(req) {
  if (!APP_SECRET) return true; // not enforced until the secret is configured
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.body).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

// POST /api/meta/webhook -> receive events.
// For now we just verify + log so we can inspect real payloads before building
// the leads data model. Always 200 fast so Meta doesn't retry/disable the hook.
router.post("/webhook", (req, res) => {
  res.sendStatus(200);
  if (!verifySignature(req)) {
    console.warn("Meta webhook: signature mismatch — ignoring payload");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
  } catch (e) {
    console.warn("Meta webhook: could not parse body");
    return;
  }
  console.log("META WEBHOOK EVENT:", JSON.stringify(payload, null, 2));
});

module.exports = router;
