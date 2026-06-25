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

module.exports = { sendWhatsAppText, isWhatsAppConfigured: isConfigured };
