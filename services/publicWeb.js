function normalizeWebBase(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!['http:', 'https:'].includes(url.protocol)) return "";
    return url.origin;
  } catch (e) {
    return "";
  }
}

function requestWebBase(req) {
  return normalizeWebBase(req?.get?.("origin"))
    || normalizeWebBase(req?.body?.returnBaseUrl)
    || normalizeWebBase(process.env.FRONTEND_URL)
    || normalizeWebBase(process.env.WEB_BASE_URL)
    || "https://codex-system-five.vercel.app";
}

module.exports = { normalizeWebBase, requestWebBase };
