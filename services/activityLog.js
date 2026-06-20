const Activity = require("../models/Activity");

// Best-effort activity logger — never throws into the main request flow.
async function logActivity({ organization, customerId, type, message, actorId = null, actorName = "" }) {
  try {
    if (!organization || !customerId || !type || !message) return;
    await Activity.create({ organization, customerId, type, message, actorId, actorName });
  } catch (e) {
    console.error("activity log error:", e.message);
  }
}

module.exports = { logActivity };
