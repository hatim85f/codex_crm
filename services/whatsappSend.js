// Outbound WhatsApp via the Meta Cloud API (Graph API).
// Credentials come from env: WHATSAPP_TOKEN (permanent/system-user token) and
// WHATSAPP_PHONE_NUMBER_ID. If they're not configured, sending is a no-op and the
// message is just stored locally (so the inbox still works in dev / before go-live).

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

const creds = () => ({
  token: process.env.WHATSAPP_TOKEN || "",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
});

const isConfigured = () => {
  const c = creds();
  return !!(c.token && c.phoneNumberId);
};

// Send a plain text message. Returns { ok, messageId?, error? }.
async function sendWhatsAppText(to, body) {
  const { token, phoneNumberId } = creds();
  if (!token || !phoneNumberId) {
    return { ok: false, skipped: true, error: "WhatsApp Cloud API not configured" };
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to).replace(/[^\d]/g, ""), // E.164 digits only
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `WhatsApp send failed (${res.status})`;
      return { ok: false, error: msg };
    }
    return { ok: true, messageId: data?.messages?.[0]?.id || "" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Send a media message (audio voice note / image / document / video) by public link.
// `type` is one of: audio | image | document | video. Returns { ok, messageId?, error? }.
async function sendWhatsAppMedia(to, type, link, caption = "") {
  const { token, phoneNumberId } = creds();
  if (!token || !phoneNumberId) return { ok: false, skipped: true, error: "WhatsApp Cloud API not configured" };
  const allowed = ["audio", "image", "document", "video"];
  if (!allowed.includes(type)) return { ok: false, error: "Unsupported media type" };
  const media = { link };
  // Audio cannot carry a caption; the others can.
  if (caption && type !== "audio") media.caption = caption;
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: String(to).replace(/[^\d]/g, ""),
        type,
        [type]: media,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || `WhatsApp media send failed (${res.status})` };
    return { ok: true, messageId: data?.messages?.[0]?.id || "" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendWhatsAppText, sendWhatsAppMedia, isWhatsAppConfigured: isConfigured };
