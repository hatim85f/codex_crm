const express = require("express");

const router = express.Router();
const FileRecord = require("../../models/FileRecord");
const Project = require("../../models/Project");
const Quotation = require("../../models/Quotation");
const Invoice = require("../../models/Invoice");
const Customer = require("../../models/Customer");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads: isAdmin, visibleAssigneeIds } = require("../../services/leadsScope");
const { categorize } = require("../../services/fileType");
const { collectVirtualFiles, SECTIONS } = require("../../services/virtualFiles");
const { FILE_TYPES, FILE_RELATED_MODULES, FILE_VISIBILITIES } = require("../../models/FileRecord");

// Every internal role can use the File Center.
const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader",
  "developer", "designer", "content_creator", "accountant", "support"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const POPULATE = [{ path: "uploadedBy", select: "name email avatar" }];

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

// ---- Folders & aggregation (live virtual files: quotations, invoices, designs) ----

// Customers this user may browse: null = all (admins), else the set tied to their
// projects + the quotations/invoices they created.
async function folderScope(req) {
  if (isAdmin(req)) return { customerIds: null };
  const org = req.user.organization;
  const set = new Set();
  const [projs, qs, invs] = await Promise.all([
    Project.find({ organization: org, isDeleted: false, $or: [{ projectLeaderId: req.user.id }, { assignedMembers: req.user.id }] }).select("customerId").lean(),
    Quotation.find({ organization: org, createdBy: req.user.id }).select("customerId").lean(),
    Invoice.find({ organization: org, createdBy: req.user.id }).select("customerId").lean(),
  ]);
  [...projs, ...qs, ...invs].forEach((d) => d.customerId && set.add(String(d.customerId)));
  return { customerIds: [...set] };
}

// All file entries (virtual sources + real uploads) the user may see, normalized
// and tagged with a customerId so they can be grouped into client folders.
async function buildEntries(req) {
  const org = req.user.organization;
  const { customerIds } = await folderScope(req);
  const virtual = await collectVirtualFiles({ organization: org, customerIds });

  const uploads = await FileRecord.find({ organization: org, isDeleted: false, isArchived: false })
    .populate(POPULATE).lean();
  // Resolve project-linked uploads to their customer.
  const projIds = uploads
    .filter((u) => ["project", "project_step", "approval_request", "final_delivery"].includes(u.relatedModule) && u.relatedRecordId)
    .map((u) => u.relatedRecordId);
  const projMap = {};
  if (projIds.length) {
    const ps = await Project.find({ _id: { $in: projIds } }).select("customerId").lean();
    ps.forEach((p) => { projMap[String(p._id)] = p.customerId ? String(p.customerId) : null; });
  }
  const uploadEntries = uploads.map((u) => {
    let customerId = null;
    if (u.relatedModule === "customer") customerId = u.relatedRecordId ? String(u.relatedRecordId) : null;
    else if (u.relatedRecordId && projMap[String(u.relatedRecordId)] !== undefined) customerId = projMap[String(u.relatedRecordId)];
    return {
      id: `upload:${u._id}`, source: "upload", section: "uploads", recordId: String(u._id),
      fileName: u.fileName, fileType: u.fileType, downloadMode: "url", fileUrl: u.fileUrl,
      routeName: "FileDetail", routeId: String(u._id), customerId,
      label: u.relatedLabel || "", date: u.createdAt, size: u.fileSize,
      uploadedBy: u.uploadedBy, visibility: u.visibility,
    };
  });

  let all = [...virtual, ...uploadEntries];
  if (customerIds) {
    const cset = new Set(customerIds);
    all = all.filter((e) => e.source !== "upload"
      ? true
      : (e.customerId && cset.has(e.customerId)) || String(e.uploadedBy?._id || e.uploadedBy || "") === String(req.user.id));
  }
  return all;
}

const emptyCounts = () => SECTIONS.reduce((a, s) => ({ ...a, [s]: 0 }), { total: 0 });

// GET /files/folders  — one folder per client + an "Internal / Unfiled" bucket
router.get("/folders", async (req, res) => {
  try {
    const entries = await buildEntries(req);
    const groups = {};
    for (const e of entries) {
      const key = e.customerId || "unfiled";
      if (!groups[key]) groups[key] = { customerId: e.customerId || null, counts: emptyCounts(), lastActivity: null };
      const g = groups[key];
      g.counts[e.section] = (g.counts[e.section] || 0) + 1;
      g.counts.total += 1;
      const t = e.date ? new Date(e.date).getTime() : 0;
      if (t && (!g.lastActivity || t > g.lastActivity)) g.lastActivity = t;
    }
    const ids = Object.values(groups).map((g) => g.customerId).filter(Boolean);
    const names = {};
    if (ids.length) {
      const custs = await Customer.find({ _id: { $in: ids } }).select("displayName companyName").lean();
      custs.forEach((c) => { names[String(c._id)] = c.displayName || c.companyName || "Customer"; });
    }
    const folders = Object.entries(groups).map(([key, g]) => ({
      id: key,
      customerId: g.customerId,
      name: g.customerId ? (names[g.customerId] || "Customer") : "Internal / Unfiled",
      counts: g.counts,
      lastActivity: g.lastActivity,
    })).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    return res.json(folders);
  } catch (err) {
    console.error("file folders error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /files/index  — flat searchable union across every source (global search)
router.get("/index", async (req, res) => {
  try {
    const { search, type, source, section } = req.query;
    let entries = await buildEntries(req);
    if (type) entries = entries.filter((e) => e.fileType === type);
    if (source) entries = entries.filter((e) => e.source === source);
    if (section) entries = entries.filter((e) => e.section === section);
    if (search) {
      const q = String(search).trim().toLowerCase();
      entries = entries.filter((e) => [e.fileName, e.label].join(" ").toLowerCase().includes(q));
    }
    entries.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
    return res.json(entries.slice(0, 300));
  } catch (err) {
    console.error("file index error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /files/folders/:customerId  — one client's files, split into sections
router.get("/folders/:customerId", async (req, res) => {
  try {
    const cid = req.params.customerId;
    const entries = await buildEntries(req);
    const mine = entries.filter((e) => (cid === "unfiled" ? !e.customerId : e.customerId === cid));
    const sections = {};
    SECTIONS.forEach((s) => { sections[s] = []; });
    mine.forEach((e) => { (sections[e.section] || (sections[e.section] = [])).push(e); });
    Object.values(sections).forEach((arr) => arr.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0)));
    let name = "Internal / Unfiled";
    if (cid !== "unfiled") {
      const c = await Customer.findById(cid).select("displayName companyName").lean();
      name = c ? (c.displayName || c.companyName || "Customer") : "Customer";
    }
    return res.json({ customerId: cid === "unfiled" ? null : cid, name, sections });
  } catch (err) {
    console.error("file folder error:", err.message);
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
