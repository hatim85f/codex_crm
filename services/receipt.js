// Generates a payment Receipt PDF (server-side, pdfkit), uploads it to Cloudinary,
// files it in the company File Center under the client, and stamps the invoice.
const PDFDocument = require("pdfkit");
const { uploadBufferToCloudinary } = require("./cloudinaryUpload");

const TEAL = "#0D6666";
const INK = "#0F1B2A";
const MUTED = "#647488";

const METHOD_LABEL = { bank_transfer: "Bank transfer", online_payment: "Online payment", cash: "Cash", card: "Card", other: "Other" };

function buildReceiptPdf({ orgName, logoBuf, receiptNumber, invoiceNumber, customerName, amountStr, currency, method, dateStr }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (logoBuf) { try { doc.image(logoBuf, 50, 48, { fit: [130, 56] }); } catch (e) { /* unsupported format */ } }
    doc.fillColor(TEAL).fontSize(18).text(orgName || "Receipt", 300, 54, { width: 245, align: "right" });

    doc.fillColor(INK).fontSize(26).text("PAYMENT RECEIPT", 50, 130);
    doc.fillColor(MUTED).fontSize(10).text(`Receipt No: ${receiptNumber}`, 50, 166);
    doc.text(`Date: ${dateStr}`, 50, 180);

    doc.moveTo(50, 205).lineTo(545, 205).strokeColor("#E6EAF1").lineWidth(1).stroke();

    doc.fillColor(MUTED).fontSize(10).text("RECEIVED FROM", 50, 225);
    doc.fillColor(INK).fontSize(15).text(customerName || "Customer", 50, 240);

    doc.roundedRect(50, 285, 495, 78, 10).fill("#F1F4F9");
    doc.fillColor(MUTED).fontSize(10).text("AMOUNT PAID", 70, 303);
    doc.fillColor(TEAL).fontSize(26).text(`${currency} ${amountStr}`, 70, 318);
    doc.roundedRect(445, 305, 80, 26, 13).fill("#0D6666");
    doc.fillColor("#FFFFFF").fontSize(12).text("PAID", 445, 312, { width: 80, align: "center" });

    doc.fillColor(MUTED).fontSize(10).text("Against invoice", 50, 390);
    doc.fillColor(INK).fontSize(12).text(invoiceNumber || "—", 50, 404);
    doc.fillColor(MUTED).fontSize(10).text("Payment method", 300, 390);
    doc.fillColor(INK).fontSize(12).text(method || "—", 300, 404);

    doc.fillColor(MUTED).fontSize(9).text("This is a computer-generated payment receipt and does not require a signature.", 50, 760, { width: 495, align: "center" });
    doc.end();
  });
}

// Generate + file the receipt for a paid invoice. Idempotent (skips if one exists).
async function fileReceipt(invoice, { amount, method = "", paidAt = new Date(), actorId = null } = {}) {
  if (invoice.receiptUrl) return invoice.receiptUrl;
  const Organization = require("../models/Organization");
  const Customer = require("../models/Customer");
  const FileRecord = require("../models/FileRecord");

  const [org, cust] = await Promise.all([
    Organization.findById(invoice.organization).select("name logo").lean(),
    Customer.findById(invoice.customerId).select("displayName companyName").lean(),
  ]);
  const customerName = cust?.displayName || cust?.companyName || "Customer";
  const currency = invoice.currency || "AED";
  const amt = Number(amount != null ? amount : invoice.grandTotal) || 0;
  const amountStr = amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const receiptNumber = `RCP-${invoice.invoiceNumber}`;
  const dateStr = new Date(paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  let logoBuf = null;
  if (org?.logo) {
    try { const r = await fetch(org.logo); if (r.ok) logoBuf = Buffer.from(await r.arrayBuffer()); } catch (e) { /* skip logo */ }
  }

  const buf = await buildReceiptPdf({
    orgName: org?.name, logoBuf, receiptNumber, invoiceNumber: invoice.invoiceNumber,
    customerName, amountStr, currency, method: METHOD_LABEL[method] || method || "—", dateStr,
  });
  const url = await uploadBufferToCloudinary(buf, `receipt-${invoice.invoiceNumber}.pdf`);

  // File it in the File Center under the client (shared with the customer).
  const fileNumber = (await FileRecord.countDocuments({ organization: invoice.organization })) + 1001;
  await FileRecord.create({
    organization: invoice.organization, fileNumber,
    fileName: `Receipt ${receiptNumber}`, originalName: `receipt-${invoice.invoiceNumber}.pdf`,
    fileType: "pdf", mimeType: "application/pdf", fileUrl: url, fileSize: buf.length,
    relatedModule: "customer", relatedRecordId: invoice.customerId, relatedLabel: `Receipt ${invoice.invoiceNumber}`,
    visibility: "shared_with_customer", uploadedBy: actorId, tags: ["receipt"],
  });

  invoice.receiptNumber = receiptNumber;
  invoice.receiptUrl = url;
  invoice.receiptFiledAt = new Date();
  await invoice.save();
  return url;
}

module.exports = { fileReceipt };
