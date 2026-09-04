// Deterministic (no AI, no ongoing cost) classifier/extractor for eBay
// purchase-related mailbox content. Replaces the Claude-based purchase path
// in janmariniReceiptParser.js -- eBay's own notification emails are varied
// in template (order confirmed, shipped, delivered, seller message, case
// closed, promo, satisfaction surveys) but the genuinely transactional ones
// reliably mention the real item name somewhere in the subject or body, so
// instead of freeform-parsing every template this checks whether any
// currently-open Shopify order's exact item name appears in the text.
// Distributor supply is expected to reduce eBay purchase volume going
// forward, and this removes the dependency on Anthropic API billing staying
// funded for what's meant to run unattended on a schedule.
//
// Deliberately allowlist-based, not blocklist-based: eBay's marketing/survey
// template variety is unbounded ("Are you enjoying your order?", "Your Cream
// Awaits! ✨", etc.) and several of these were observed live to false-match a
// real item name in body copy. Trying to enumerate every non-transactional
// phrasing is a losing game; only extracting from subjects that are clearly
// part of the order lifecycle is far safer, at the cost of occasionally
// missing an oddly-worded genuine one (which just sits unprocessed for a
// human to notice, rather than silently creating a wrong Purchase record).
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");

// Subjects worth attempting item extraction on -- genuine order-lifecycle
// transactional emails.
const TRANSACTIONAL_SUBJECT_PATTERNS = [
  /order (is )?confirmed/i,
  /order update/i,
  /order delivered/i,
  /package is now with its carrier/i,
  /has shipped/i,
  /\bshipped\b/i,
  /tracking/i,
];

// Shown to the owner (subject line carries the real signal -- a seller
// warning about a delay, an order being cancelled, a refund issued) but
// never auto-extracted into a purchase. These aren't receipts, and applying
// one would risk exactly the bug seen live: a cancellation email's "similar
// items" footer matched an unrelated open order's item name, which would
// have recorded it as purchased for the cancelled item's refund amount.
// Visibility without extraction is the point -- the owner needs to see a
// cancellation happened, but the system should never guess a purchase out of
// free-text chat or a refund notice.
const INFORMATIONAL_ONLY_SUBJECT_PATTERNS = [
  /sent a message about/i,
  /has been cancel/i,
  /order cancel/i,
  /refund is on its way/i,
  /refund/i,
];

// Explicit noise this mailbox reliably contains -- kept as a fast-path even
// though the primary safety net is now the allowlist above.
const IGNORE_SUBJECT_PATTERNS = [
  /this request is closed/i,
  /case #\d+.*closed/i,
  /\bsale\b/i,
  /\bdeal(s)? of the day\b/i,
  /discover your/i,
  /newsletter/i,
  /price dropped/i,
  /was\s*\$?\s*[\d.,]+,?\s*now/i, // "Was $62.00 now $52.70" / "Was AED113.99, Now AED3.81" promo style
];

// eBay's own emails routinely end with a "SIMILAR ITEMS" / related-products
// footer listing unrelated products by name, and scatter unrelated dollar
// figures throughout (shipping insurance, "similar items" prices, refund
// totals) -- both are unreliable to extract from. Cut the haystack off
// before any such footer marker for item-name matching.
const FOOTER_MARKERS = [/similar items/i, /you might also like/i, /customers also bought/i, /recommended for you/i];

function stripFooter(text) {
  let cut = (text || "").length;
  for (const marker of FOOTER_MARKERS) {
    const m = marker.exec(text || "");
    if (m && m.index < cut) cut = m.index;
  }
  return (text || "").slice(0, cut);
}

const ORDER_NUMBER_RE = /\bOrder number:\s*([\w-]{6,25})/i;

const SHIPMENT_KEYWORDS = ["aramex", "shop & ship", "shopandship", "shop and ship", "waybill", "tracking number", "compliance check"];

function isIgnored(subject) {
  return IGNORE_SUBJECT_PATTERNS.some((re) => re.test(subject || ""));
}

function isTransactional(subject) {
  return TRANSACTIONAL_SUBJECT_PATTERNS.some((re) => re.test(subject || ""));
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[®™]/g, "").replace(/\s+/g, " ").trim();
}

function extractOrderNumber(text) {
  const m = ORDER_NUMBER_RE.exec(text || "");
  return m ? m[1] : "";
}

// A mailbox that receives both eBay bills and Shop & Ship screenshots
// (mariniorders@) can't have its content type assumed from the source alone.
// This used to be a Claude call; a keyword check is just as reliable here
// since the two content types use very different vocabulary.
function classifyContentTypeDeterministic(receipt) {
  const text = `${receipt.subject || ""} ${receipt.bodyText || ""}`.toLowerCase();
  return SHIPMENT_KEYWORDS.some((k) => text.includes(k)) ? "shipment" : "purchase";
}

// Finds open-order candidate items whose exact name appears as a normalized
// substring somewhere in the email text. Requires a reasonably long name (8+
// chars) so short/generic words can't false-match.
async function findCandidateItemMatches(haystackRaw) {
  const haystack = normalize(haystackRaw);
  const orders = await ShopifyOrder.find({ ignored: false }).select("orderNumber items.name").lean();
  const matches = [];
  for (const o of orders) {
    for (const item of o.items || []) {
      const needle = normalize(item.name);
      if (needle.length >= 8 && haystack.includes(needle)) {
        matches.push({ orderNumber: o.orderNumber, itemName: item.name });
      }
    }
  }
  const seen = new Set();
  return matches.filter((m) => {
    const key = `${m.orderNumber}::${m.itemName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Returns the same { list, contentType: "purchase" } shape the AI path
// produced, so nothing downstream (Confirmations screen, confirm/apply
// logic) needs to change. `ignore: true` means auto-reject without ever
// showing this to the owner (promo/closed-case/non-transactional noise).
//
// Cost is deliberately never auto-filled here (always 0) -- these are
// notification emails, not itemized invoices, and the one live test run
// showed the same item getting wildly different "prices" pulled from
// unrelated dollar figures in different emails. A human fills in real cost
// from the actual eBay order/invoice, same as many existing records already
// do.
async function extractPurchaseDeterministic(receipt) {
  const subject = receipt.subject || "";

  if (isIgnored(subject)) {
    return { list: [], contentType: "purchase", ignore: true };
  }

  if (INFORMATIONAL_ONLY_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    // Surfaced via the receipt's own subject line on the Confirmations
    // screen for human attention -- never auto-extracted.
    return { list: [], contentType: "purchase", ignore: false };
  }

  if (!isTransactional(subject)) {
    return { list: [], contentType: "purchase", ignore: true };
  }

  const strippedBody = stripFooter(receipt.bodyText || "");
  const haystack = `${subject}\n${strippedBody}`;
  const uniqueMatches = await findCandidateItemMatches(haystack);
  if (!uniqueMatches.length) {
    return { list: [], contentType: "purchase", ignore: false };
  }

  const ebayOrderNumber = extractOrderNumber(strippedBody || subject);
  // More than one distinct item matched in the same email -- don't guess
  // which one the order number belongs to.
  const ambiguous = uniqueMatches.length > 1;

  const list = uniqueMatches.map((m) => ({
    matchedOrderNumber: m.orderNumber,
    itemName: m.itemName,
    quantity: 1,
    costUSD: 0,
    seller: "",
    ebayOrderNumber: ambiguous ? "" : ebayOrderNumber,
    sellerTracking: "",
    confidence: ambiguous ? "low" : "high",
    notes: ambiguous
      ? `Email text matched ${uniqueMatches.length} different open orders' items -- confirm the right one manually.`
      : "",
  }));

  return { list, contentType: "purchase", ignore: false };
}

module.exports = { extractPurchaseDeterministic, classifyContentTypeDeterministic };
