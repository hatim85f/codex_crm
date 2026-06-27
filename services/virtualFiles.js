// Virtual file sources — surfaces existing CRM records (quotations, invoices,
// project deliveries/approvals) as downloadable "files" WITHOUT duplicating or
// re-uploading them. Everything is computed live from the source data.
//
// === HOW TO ADD / CHANGE A SOURCE ===
// Add (or edit) one object in FILE_SOURCES below. A source maps its records to
// normalized file entries; nothing else in the app needs to change. To add a
// section (e.g. "communications", "accounting"), add it to SECTIONS and point a
// source's `section` at it. To temporarily disable a source, set enabled: false.

const Quotation = require("../models/Quotation");
const Invoice = require("../models/Invoice");
const ProjectDelivery = require("../models/ProjectDelivery");
const ProjectApproval = require("../models/ProjectApproval");
const { categorize } = require("./fileType");

// Folder sections, in display order. Extensible.
const SECTIONS = ["quotations", "invoices", "designs", "uploads"];

// Normalize one entry into the shape the frontend renders + downloads.
const entry = (o) => ({
  id: o.id,
  source: o.source,
  section: o.section,
  recordId: o.recordId ? String(o.recordId) : null,
  fileName: o.fileName || "File",
  fileType: o.fileType || "other",
  // "live_pdf" = frontend fetches the record and generates the PDF on the fly;
  // "url" = direct download/open of fileUrl.
  downloadMode: o.downloadMode || "url",
  fileUrl: o.fileUrl || "",
  routeName: o.routeName || "",
  routeId: o.routeId ? String(o.routeId) : null,
  customerId: o.customerId ? String(o.customerId) : null,
  label: o.label || "",
  date: o.date || null,
  size: o.size || 0,
});

const scoped = (organization, customerIds, extra = {}) => {
  const q = { organization, ...extra };
  if (customerIds) q.customerId = { $in: customerIds };
  return q;
};

const FILE_SOURCES = [
  {
    key: "quotation",
    section: "quotations",
    enabled: true,
    async load({ organization, customerIds }) {
      const rows = await Quotation.find(scoped(organization, customerIds, { isDeleted: { $ne: true } }))
        .select("quotationNumber customerId issueDate createdAt").lean();
      return rows.map((r) => entry({
        id: `quotation:${r._id}`, source: "quotation", section: "quotations",
        recordId: r._id, fileName: `Quotation ${r.quotationNumber}`,
        fileType: "pdf", downloadMode: "live_pdf",
        routeName: "QuotationDetail", routeId: r._id,
        customerId: r.customerId, label: r.quotationNumber, date: r.issueDate || r.createdAt,
      }));
    },
  },
  {
    key: "invoice",
    section: "invoices",
    enabled: true,
    async load({ organization, customerIds }) {
      const rows = await Invoice.find(scoped(organization, customerIds, { isDeleted: { $ne: true } }))
        .select("invoiceNumber customerId issueDate createdAt").lean();
      return rows.map((r) => entry({
        id: `invoice:${r._id}`, source: "invoice", section: "invoices",
        recordId: r._id, fileName: `Invoice ${r.invoiceNumber}`,
        fileType: "pdf", downloadMode: "live_pdf",
        routeName: "InvoiceDetail", routeId: r._id,
        customerId: r.customerId, label: r.invoiceNumber, date: r.issueDate || r.createdAt,
      }));
    },
  },
  {
    key: "project_delivery",
    section: "designs",
    enabled: true,
    async load({ organization, customerIds }) {
      const rows = await ProjectDelivery.find(scoped(organization, customerIds))
        .select("title deliveryFiles deliveryLinks customerId projectId createdAt").lean();
      const out = [];
      rows.forEach((d) => {
        (d.deliveryFiles || []).forEach((f, i) => out.push(entry({
          id: `delivery_file:${d._id}:${i}`, source: "project_delivery", section: "designs",
          recordId: d._id, fileName: f.fileName || `${d.title} file`,
          fileType: categorize(f.fileType, f.fileName), downloadMode: "url", fileUrl: f.fileUrl,
          routeName: "ProjectDetail", routeId: d.projectId,
          customerId: d.customerId, label: d.title, date: f.uploadedAt || d.createdAt, size: f.fileSize,
        })));
        (d.deliveryLinks || []).forEach((l, i) => out.push(entry({
          id: `delivery_link:${d._id}:${i}`, source: "project_delivery", section: "designs",
          recordId: d._id, fileName: l.label || `${d.title} link`,
          fileType: "other", downloadMode: "url", fileUrl: l.url,
          routeName: "ProjectDetail", routeId: d.projectId,
          customerId: d.customerId, label: d.title, date: d.createdAt,
        })));
      });
      return out;
    },
  },
  {
    key: "project_approval",
    section: "designs",
    enabled: true,
    async load({ organization, customerIds }) {
      const rows = await ProjectApproval.find(scoped(organization, customerIds))
        .select("title files links customerId projectId createdAt").lean();
      const out = [];
      rows.forEach((a) => {
        (a.files || []).forEach((f, i) => out.push(entry({
          id: `approval_file:${a._id}:${i}`, source: "project_approval", section: "designs",
          recordId: a._id, fileName: f.fileName || `${a.title} file`,
          fileType: categorize(f.fileType, f.fileName), downloadMode: "url", fileUrl: f.fileUrl,
          routeName: "ProjectDetail", routeId: a.projectId,
          customerId: a.customerId, label: a.title, date: f.uploadedAt || a.createdAt, size: f.fileSize,
        })));
        (a.links || []).forEach((l, i) => out.push(entry({
          id: `approval_link:${a._id}:${i}`, source: "project_approval", section: "designs",
          recordId: a._id, fileName: l.label || `${a.title} link`,
          fileType: "other", downloadMode: "url", fileUrl: l.url,
          routeName: "ProjectDetail", routeId: a.projectId,
          customerId: a.customerId, label: a.title, date: a.createdAt,
        })));
      });
      return out;
    },
  },
];

// Run every enabled source and return the merged, normalized entries.
async function collectVirtualFiles(ctx) {
  const out = [];
  for (const s of FILE_SOURCES) {
    if (s.enabled === false) continue;
    try {
      out.push(...(await s.load(ctx)));
    } catch (e) {
      console.error(`virtual file source "${s.key}" error:`, e.message);
    }
  }
  return out;
}

module.exports = { FILE_SOURCES, SECTIONS, collectVirtualFiles, normalizeEntry: entry };
