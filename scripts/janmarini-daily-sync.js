// Heroku Scheduler entry point: `node scripts/janmarini-daily-sync.js`, once daily.
require("dotenv").config();
const janmariniConn = require("../config/janmariniDb");
const { runDailySync } = require("../services/janmariniSync");

(async () => {
  try {
    const result = await runDailySync();
    console.log("[janmarini] Daily sync result:", JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (e) {
    console.error("[janmarini] Daily sync failed:", e.message);
    process.exitCode = 1;
  } finally {
    await janmariniConn.close().catch(() => {});
    process.exit();
  }
})();
