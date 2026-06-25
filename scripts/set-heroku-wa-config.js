// One-off helper: copy the Meta/WhatsApp credentials from local .env up to the
// Heroku app config, so the deployed backend can SEND WhatsApp messages (and
// verify webhook signatures). Run once:  node scripts/set-heroku-wa-config.js
require("dotenv").config();
const { spawnSync } = require("child_process");

const APP = "codex-crm";
const KEYS = [
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "META_APP_SECRET",
  "META_APP_ID",
  "META_GRAPH_VERSION",
];

const pairs = KEYS.filter((k) => process.env[k] && String(process.env[k]).trim())
  .map((k) => `${k}=${String(process.env[k]).trim()}`);

if (!pairs.length) {
  console.error("No matching keys found in .env");
  process.exit(1);
}

console.log("Setting on Heroku app '" + APP + "':", pairs.map((p) => p.split("=")[0]).join(", "));
const r = spawnSync("heroku", ["config:set", ...pairs, "-a", APP], { shell: true, stdio: "inherit" });
process.exit(r.status || 0);
