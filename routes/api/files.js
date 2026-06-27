const express = require("express");

const router = express.Router();
const FileRecord = require("../../models/FileRecord");
const Project = require("../../models/Project");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads: isAdmin, visibleAssigneeIds } = require("../../services/leadsScope");
const { FILE_TYPES, FILE_RELATED_MODULES, FILE_VISIBILITIES } = require("../../models/FileRecord");

// Every internal role can use the File Center.
const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader",
  "developer", "designer", "content_creator", "accountant", "support"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const POPULATE = [{ path: "uploadedBy", select: "name email avatar" }];

// Categorize a file into a coarse type for badges/filters.
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

// Projects the (non-admin) user may access — they lead it or are a member.
async function accessibleProjectIds(req) {
  const projs = await Project.find({
    organization: req.user.organization,
    isDeleted: false,
    $or: [{ projectLeaderId: req.user.id }, { assignedMembers: req.user.id }],
  }).select("_id");
  return projs.map((p) => p._id);
}

// Uploaders whose files this (non-admin) user may see: self + team members (if
// team_leader) + members of projects they lead.
async function visibleUploaderIds(req) {
  const ids = new Set(await visibleAssigneeIds(req)); // self (+ team for team_leader)
  const led = await Project.find({
    organization: req.user.organization, isDeleted: false, projectLeaderId: req.user.id,
  }).select("assignedMembers");
  led.forEach((p) => (p.assignedMembers || []).forEach((m) => m && ids.add(String(m))));
  return [...ids];
}

// Visibility clause for the file list, or null for admins (who see everything).
//   - owner_admin / admin -> all
//   - everyone else -> files they/their team uploaded OR files on projects they can access
async function fileScope(req) {
  if (isAdmin(req)) return null;
  const uploaders = await visibleUploaderIds(req);
  const projectIds = await accessibleProjectIds(req);
  const or = [{ uploadedBy: { $in: uploaders } }];
  if (projectIds.length) or.push({ relatedModule: "project", relatedRecordId: { $in: projectIds } });
  return { $or: or };
}

async function loadFile(req, res) {
  const file = await FileRecord.findById(req.params.id).populate(POPULATE);
  if (!file || file.isDeleted || String(file.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "File not found" });
    return null;
  }
  const scope = await fileScope(req);
  if (scope) {
    const ok = await FileRecord.exists({ _id: file._id, ...scope });
    if (!ok) { res.status(404).json({ message: "File not found" }); return null; }
  }
  return file;
}

// GET /files  (filters: type, relatedModule, uploadedBy, visibility, search, dateFrom, dateTo, archived)
router.get("/", async (req, res) => {
  try {
    const { type, relatedModule, uploadedBy, visibility, search, dateFrom, dateTo, archived } = req.query;
    const query = { organization: req.user.organization, isDeleted: false };
    query.isArchived = archived === "true" ? true : archived === "all" ? { $in: [true, false] } : false;
    if (type) query.fileType = type;
    if (relatedModule) query.relatedModule = relatedModule;
    if (uploadedBy) query.uploadedBy = uploadedBy;
    if (visibility) query.visibility = visibility;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }
    const and = [];
    const scope = await fileScope(req);
    if (scope) and.push(scope);
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      and.push({ $or: [{ fileName: rx }, { originalName: rx }, { relatedLabel: rx }, { tags: rx }] });
    }
    if (and.length) query.$and = and;
    const items = await FileRecord.find(query).populate(POPULATE).sort({ createdAt: -1 }).limit(500);
    return res.json(items);
  } catch (err) {
    console.error("list files error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /files/summary  (home overview cards) — must precede /:id
router.get("/summary", async (req, res) => {
  try {
    const base = { organization: req.user.organization, isDeleted: false, isArchived: false };
    const scope = await fileScope(req);
    const visible = scope ? { ...base, ...scope } : base;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [total, recent, project, customer, tasks, support, delivery, shared, archived] = await Promise.all([
      FileRecord.countDocuments(visible),
      FileRecord.countDocuments({ ...visible, createdAt: { $gte: weekAgo } }),
      FileRecord.countDocuments({ ...visible, relatedModule: { $in: ["project", "project_step"] } }),
      FileRecord.countDocuments({ ...visible, relatedModule: { $in: ["customer", "potential_customer"] } }),
      FileRecord.countDocuments({ ...visible, relatedModule: "task" }),
      FileRecord.countDocuments({ ...visible, relatedModule: { $in: ["support_conversation", "contact_message"] } }),
      FileRecord.countDocuments({ ...visible, relatedModule: { $in: ["final_delivery", "approval_request"] } }),
      FileRecord.countDocuments({ ...visible, visibility: "shared_with_customer" }),
      FileRecord.countDocuments({ organization: req.user.organization, isDeleted: false, isArchived: true, ...(scope || {}) }),
    ]);
    return res.json({ total, recent, project, customer, tasks, support, delivery, shared, archived });
  } catch (err) {
    console.error("file summary error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /files/upload  (metadata only — the file is uploaded to Cloudinary client-side)
router.post("/upload", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.fileUrl) return res.status(400).json({ message: "fileUrl is required" });
    const originalName = b.originalName || b.fileName || "file";
    const fileType = FILE_TYPES.includes(b.fileType) ? b.fileType : categorize(b.mimeType, originalName);
    const fileNumber = (await FileRecord.countDocuments({ organization: req.user.organization })) + 1001;
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    const file = await FileRecord.create({
      organization: req.user.organization,
      fileNumber,
      fileName: (b.fileName && String(b.fileName).trim()) || originalName,
      originalName,
      fileType,
      mimeType: b.mimeType || "",
      fileUrl: b.fileUrl,
      fileSize: Number(b.fileSize) || 0,
      description: b.description || "",
      relatedModule: FILE_RELATED_MODULES.includes(b.relatedModule) ? b.relatedModule : "none",
      relatedRecordId: b.relatedRecordId || null,
      relatedLabel: b.relatedLabel || "",
      visibility: FILE_VISIBILITIES.includes(b.visibility) ? b.visibility : "internal_only",
      tags,
      uploadedBy: req.user.id,
      updatedBy: req.user.id,
    });
    const out = await FileRecord.findById(file._id).populate(POPULATE);
    return res.status(201).json(out);
  } catch (err) {
    console.error("upload file error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /files/:id
router.get("/:id", async (req, res) => {
  try {
    const file = await loadFile(req, res);
    if (!file) return;
    return res.json(file);
  } catch (err) {
    console.error("get file error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /files/:id  (rename / description / tags / relink)
router.patch("/:id", async (req, res) => {
  try {
    const file = await loadFile(req, res);
    if (!file) return;
    const b = req.body || {};
    if (b.fileName !== undefined) file.fileName = String(b.fileName).trim() || file.fileName;
    if (b.description !== undefined) file.description = b.description;
    if (Array.isArray(b.tags)) file.tags = b.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
    if (b.relatedModule !== undefined && FILE_RELATED_MODULES.includes(b.relatedModule)) file.relatedModule = b.relatedModule;
    if (b.relatedRecordId !== undefined) file.relatedRecordId = b.relatedRecordId || null;
    if (b.relatedLabel !== undefined) file.relatedLabel = b.relatedLabel;
    if (b.visibility !== undefined && FILE_VISIBILITIES.includes(b.visibility)) file.visibility = b.visibility;
    file.updatedBy = req.user.id;
    await file.save();
    const out = await FileRecord.findById(file._id).populate(POPULATE);
    return res.json(out);
  } catch (err) {
    console.error("update file error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /files/:id/visibility  { visibility }
router.patch("/:id/visibility", async (req, res) => {
  try {
    const { visibility } = req.body || {};
    if (!FILE_VISIBILITIES.includes(visibility)) return res.status(400).json({ message: "Invalid visibility" });
    const file = await loadFile(req, res);
    if (!file) return;
    file.visibility = visibility;
    file.updatedBy = req.user.id;
    await file.save();
    return res.json({ ok: true, _id: file._id, visibility });
  } catch (err) {
    console.error("file visibility error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /files/:id/archive  { isArchived }  (defaults to toggling)
router.patch("/:id/archive", async (req, res) => {
  try {
    const file = await loadFile(req, res);
    if (!file) return;
    file.isArchived = typeof req.body?.isArchived === "boolean" ? req.body.isArchived : !file.isArchived;
    file.updatedBy = req.user.id;
    await file.save();
    return res.json({ ok: true, _id: file._id, isArchived: file.isArchived });
  } catch (err) {
    console.error("file archive error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /files/:id  (soft)
router.delete("/:id", async (req, res) => {
  try {
    const file = await loadFile(req, res);
    if (!file) return;
    file.isDeleted = true;
    file.updatedBy = req.user.id;
    await file.save();
    return res.json({ ok: true, _id: file._id });
  } catch (err) {
    console.error("delete file error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
