// One-off helper: subscribe this app to the WhatsApp Business Account so Meta
// delivers inbound message webhooks. Run once:  node scripts/subscribe-waba.js
require("dotenv").config();

const V = (process.env.META_GRAPH_VERSION || "v21.0").trim();
const waba = (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim();
const token = (process.env.WHATSAPP_TOKEN || "").trim();

(async () => {
  if (!waba || !token) {
    console.error("Missing WHATSAPP_BUSINESS_ACCOUNT_ID or WHATSAPP_TOKEN in .env");
    process.exit(1);
  }
  const url = "https://graph.facebook.com/" + V + "/" + waba + "/subscribed_apps";
  const post = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token } });
  console.log("subscribe:", post.status, JSON.stringify(await post.json()));
  const get = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  console.log("subscribed_apps now:", JSON.stringify(await get.json()));
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
