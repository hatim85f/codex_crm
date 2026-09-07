// Deterministic parser for eBay's own "Order details" PDF (the purchase
// bill you download right after checkout) -- NOT the marketing/status email
// parser in janmariniReceiptParserRules.js. This is safe to auto-extract
// from: the PDF layout is fixed and consistent (verified against ~10 real
// bills), unlike freeform emails, so there's no ambiguity-driven mismatch
// risk here. The owner still manually assigns each extracted line to a
// Shopify order (see routes/api/janmarini.js owner/purchases/*) -- this
// module only turns the PDF into structured candidates, it never decides
// which order an item belongs to.
const { PDFParse } = require("pdf-parse");

// A bill can have items from several sellers/eBay orders bundled into one
// PDF (a single PayPal-style checkout across multiple sellers) -- each gets
// its own "Items bought from X / Order number: Y" section.
const SELLER_SECTION_RE = /Items bought from (\S+)\s*\r?\nOrder number:\s*([\w-]{6,25})/gi;

// One line item: "<qty> <item name> (<ebay listing id>) <shipping service> US $<price>"
// or split across the shipping-service/price wrap seen in some exports. The
// price is always the LAST "US $<amount>" (or "$<amount> USD") on the line/
// block -- earlier dollar figures (if any) belong to shipping cost text.
// The parenthesized listing id is captured too -- eBay's "shipped"/"order
// update" notification emails carry this same id as `itemId` in their
// tracking links, which is a far more reliable join key than "Order number"
// (unique per item, not per multi-item checkout) for later matching a
// shipping-status update back to this exact Purchase record.
const ITEM_LINE_RE = /(\d+)\s+(.+?)\s*\((\d{9,15})\)[\s\S]*?(?:US\s*\$|\$)\s*([\d,]+\.\d{2})(?:\s*USD)?/g;

function parsePlacedOn(text) {
  const m = /Placed on\s*([A-Za-z]+ \d{1,2},\s*\d{4})/.exec(text);
  return m ? new Date(m[1]) : null;
}

async function parseEbayBillPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  const text = result.text || "";

  const purchaseDate = parsePlacedOn(text);

  // Split the text into per-seller sections so item lines are attributed to
  // the right seller/eBay order number even when a bill has more than one.
  const sections = [];
  let match;
  const markers = [];
  SELLER_SECTION_RE.lastIndex = 0;
  while ((match = SELLER_SECTION_RE.exec(text))) {
    markers.push({ index: match.index, seller: match[1], ebayOrderNumber: match[2] });
  }
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    sections.push({ ...markers[i], body: text.slice(start, end) });
  }

  const items = [];
  for (const section of sections) {
    ITEM_LINE_RE.lastIndex = 0;
    let m;
    while ((m = ITEM_LINE_RE.exec(section.body))) {
      const quantity = Number(m[1]) || 1;
      const rawName = m[2].replace(/\s+/g, " ").trim();
      const ebayItemId = m[3];
      // eBay's own bill shows this as the LINE total, not a per-unit price
      // (confirmed against a real 2-unit line) -- divide down so it matches
      // this system's per-unit costUSD convention. The user still sees and
      // can edit this before anything is saved, so an unaccounted-for
      // line-level discount just means a few-cent rounding difference, not a
      // wrong Purchase record.
      const lineTotalUSD = Number(m[4].replace(/,/g, ""));
      const costUSD = Math.round((lineTotalUSD / quantity) * 100) / 100;
      items.push({
        itemName: rawName,
        quantity,
        costUSD,
        lineTotalUSD,
        seller: section.seller,
        ebayOrderNumber: section.ebayOrderNumber,
        ebayItemId,
      });
    }
  }

  return { purchaseDate, items };
}

module.exports = { parseEbayBillPdf };
