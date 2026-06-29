// Upload a generated file buffer (e.g. a receipt PDF) to Cloudinary via the
// unsigned preset. Returns the secure_url. (PDF/ZIP delivery must be allowed in
// the Cloudinary account security settings — it is for cloud dt3u7d1tv.)
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "dt3u7d1tv";
const PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || "Codex-CRM";

async function uploadBufferToCloudinary(buffer, filename = "file.pdf", mime = "application/pdf") {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  form.append("upload_preset", PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/auto/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok || !data.secure_url) throw new Error(data?.error?.message || "Cloudinary upload failed");
  return data.secure_url;
}

module.exports = { uploadBufferToCloudinary };
