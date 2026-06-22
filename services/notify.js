const Notification = require("../models/Notification");

// Best-effort notification creator - never throws into the main request flow.
async function createNotification({ organization, recipientUserId, type, title, message, link = "", meta = null, audience = "" }) {
  try {
    if (!organization || !recipientUserId || !type || !title || !message) return null;
    return await Notification.create({ organization, recipientUserId, audience, type, title, message, link, meta });
  } catch (e) {
    console.error("notification error:", e.message);
    return null;
  }
}

async function createNotifications({ organization, recipientUserIds = [], type, title, message, link = "", meta = null, audience = "" }) {
  try {
    const uniqueIds = [...new Set((recipientUserIds || []).filter(Boolean).map((id) => String(id)))];
    if (!uniqueIds.length) return [];
    await Promise.all(uniqueIds.map((recipientUserId) => createNotification({
      organization,
      recipientUserId,
      type,
      title,
      message,
      link,
      meta,
      audience,
    })));
  } catch (e) {
    console.error("notifications error:", e.message);
  }
  return [];
}

module.exports = { createNotification, createNotifications };
