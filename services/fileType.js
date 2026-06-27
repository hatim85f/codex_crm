// Categorize a file into a coarse type for badges/filters. Shared by the File
// Center upload route and the virtual-file aggregation.
function categorize(mimeType = "", name = "") {
  const m = String(mimeType).toLowerCase();
  const ext = String(name).toLowerCase().split(".").pop();
  if (m.includes("pdf") || ext === "pdf") return "pdf";
  if (["xls", "xlsx", "csv"].includes(ext) || m.includes("spreadsheet") || m.includes("excel")) return "sheet";
  if (["ppt", "pptx"].includes(ext) || m.includes("presentation") || m.includes("powerpoint")) return "presentation";
  if (["doc", "docx", "rtf", "txt"].includes(ext) || m.includes("word") || m.includes("msword") || m.startsWith("text/")) return "doc";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (m.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || m.includes("zip") || m.includes("compressed")) return "archive";
  return "other";
}

module.exports = { categorize };
