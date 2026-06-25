// Inbound WhatsApp media handling: WhatsApp only sends us a media *id*. To make
// the audio/image/file actually playable in the inbox we download the bytes
// (authenticated) and re-host them on Cloudinary, returning a public URL.

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const token = () => (process.env.WHATSAPP_TOKEN || "").trim();

// Cloud name + unsigned preset are public (same values the frontend uses), so we
// fall back to them — inbound media re-hosting then works even if Heroku config
// doesn't set these vars explicitly.
const CLOUD = (process.env.CLOUDINARY_CLOUD_NAME || "dt3u7d1tv").trim();
const PRESET = (process.env.CLOUDINARY_UPLOAD_PRESET || "Codex-CRM").trim();

async function uploadBufferToCloudinary(buffer, filename) {
  if (!CLOUD || !PRESET) throw new Error("Cloudinary not configured");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("upload_preset", PRESET);
  // "auto" lets Cloudinary store audio/video/raw/image appropriately.
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/auto/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok || !data.secure_url) throw new Error(data?.error?.message || "Cloudinary upload failed");
  return data.secure_url;
}

// Download a WhatsApp media object by id and re-host it. Returns a public URL ("" on failure).
async function fetchAndStoreMedia(mediaId) {
  const t = token();
  if (!mediaId || !t) return "";
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, { headers: { Authorization: "Bearer " + t } });
    const meta = await metaRes.json();
    if (!meta?.url) return "";
    const binRes = await fetch(meta.url, { headers: { Authorization: "Bearer " + t } });
    if (!binRes.ok) return "";
    const buf = Buffer.from(await binRes.arrayBuffer());
    const ext = String(meta.mime_type || "").split("/")[1]?.split(";")[0] || "bin";
    return await uploadBufferToCloudinary(buf, `wa_${mediaId}.${ext}`);
  } catch (e) {
    console.error("WhatsApp media fetch/store failed:", e.message);
    return "";
  }
}

module.exports = { fetchAndStoreMedia };
