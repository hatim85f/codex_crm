// Heroku Scheduler entry point: `node scripts/janmarini-daily-sync.js`, once daily.
require("dotenv").config();
const connectDB = require("../config/db");
const janmariniConn = require("../config/janmariniDb");
const { runDailySync } = require("../services/janmariniSync");

(async () => {
  try {
    // The CRM auto-sync step reads/writes EcommerceOrderProfit on Codex CRM's
    // own default connection — this script otherwise only connects the
    // separate janmarini_fulfillment DB, which left that step's queries
    // hanging until they timed out.
    await connectDB();
    const result = await runDailySync();
    console.log("[janmarini] Daily sync result:", JSON.stringify(result, null, 2));
    if (!result.ok) {
      throw new Error(`Critical sync failure: ${result.criticalErrors.join("; ")}`);
    }
    process.exitCode = 0;
  } catch (e) {
    console.error("[janmarini] Daily sync failed:", e.message);
    process.exitCode = 1;
  } finally {
    await janmariniConn.close().catch(() => {});
    process.exit();
  }
})();
