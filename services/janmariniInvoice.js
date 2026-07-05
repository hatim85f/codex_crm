// Generates a customer-facing invoice PDF for a Shopify order (server-side,
// pdfkit), uploads it to Cloudinary, and caches the URL on the order.
//
// Shopify's native Order Printer app has no headless/API way to produce this
// — it only renders an authenticated admin-session page for a human to
// "Print to PDF" in the browser. So instead of depending on that app, this
// builds an equivalent invoice directly from the order data we already sync
// from Shopify (items, prices, customer, shipping address).
const PDFDocument = require("pdfkit");
const { uploadBufferToCloudinary } = require("./cloudinaryUpload");
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");

const TEAL = "#0D6666";
const INK = "#0F1B2A";
const MUTED = "#647488";

function buildInvoicePdf(order) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const dateStr = order.orderDate
      ? new Date(order.orderDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "";

    doc.fillColor(TEAL).fontSize(18).text("Jan Marini M.E.", 50, 50);
    doc.fillColor(INK).fontSize(26).text("INVOICE", 50, 100);
    doc.fillColor(MUTED).fontSize(10).text(`Order: ${order.orderNumber}`, 50, 136);
    doc.text(`Date: ${dateStr}`, 50, 150);

    doc.moveTo(50, 175).lineTo(545, 175).strokeColor("#E6EAF1").lineWidth(1).stroke();

    doc.fillColor(MUTED).fontSize(10).text("BILL TO", 50, 195);
    doc.fillColor(INK).fontSize(13).text(order.customerName || "Customer", 50, 210);
    if (order.customerPhone) doc.fillColor(MUTED).fontSize(10).text(order.customerPhone, 50, 228);
    if (order.customerEmail) doc.fillColor(MUTED).fontSize(10).text(order.customerEmail, 50, 242);
    const addr = order.shippingAddress || {};
    const addrLine = [addr.address1, addr.address2, addr.city, addr.country].filter(Boolean).join(", ");
    if (addrLine) doc.fillColor(MUTED).fontSize(10).text(addrLine, 50, 256, { width: 300 });

    let y = 300;
    doc.fillColor(MUTED).fontSize(9).text("ITEM", 50, y);
    doc.text("QTY", 340, y);
    doc.text("UNIT PRICE", 400, y);
    doc.text("TOTAL", 490, y);
    y += 16;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E6EAF1").lineWidth(1).stroke();
    y += 12;

    for (const item of order.items || []) {
      const lineTotal = (item.price || 0) * (item.quantity || 1);
      doc.fillColor(INK).fontSize(10).text(item.name, 50, y, { width: 280 });
      doc.text(String(item.quantity || 1), 340, y);
      doc.text(`${order.currency} ${(item.price || 0).toFixed(2)}`, 400, y);
      doc.text(`${order.currency} ${lineTotal.toFixed(2)}`, 490, y);
      y += 22;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E6EAF1").lineWidth(1).stroke();
    y += 16;
    doc.fillColor(MUTED).fontSize(11).text("TOTAL", 400, y);
    doc.fillColor(TEAL).fontSize(15).text(`${order.currency} ${(order.totalPrice || 0).toFixed(2)}`, 480, y - 3);

    doc.fillColor(MUTED).fontSize(9).text("This is a computer-generated invoice.", 50, 760, { width: 495, align: "center" });
    doc.end();
  });
}

// Generates once and caches the URL on the order (idempotent — cheap to call
// on every sync run since it skips immediately once generated).
async function ensureOrderInvoice(order) {
  if (order.invoiceUrl) return order.invoiceUrl;
  const buf = await buildInvoicePdf(order);
  const url = await uploadBufferToCloudinary(buf, `invoice-${order.orderNumber.replace("#", "")}.pdf`);
  await ShopifyOrder.updateOne({ _id: order._id }, { invoiceUrl: url });
  return url;
}

module.exports = { ensureOrderInvoice };
