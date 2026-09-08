// Watches eBay mail for real seller/USPS tracking numbers and, when found,
// completes the whole chain automatically: Purchase.sellerTracking gets set,
// status flips to shipped_by_seller, and the package is registered with
// Shipito (createPackage) so syncShipitoStatus() can start polling it.
//
// Correction to an earlier assumption in this file: eBay's "shipped"
// notifications were checked and found NOT to include a tracking number as
// plain text -- but that was only true for the specific templates checked at
// the time (subject "🚚 Order update: ..." / "package is now with its
// carrier"). Re-checking against a wider set of real captured emails found
// TWO templates that DO carry the real number in plain text:
//   - eBay's own "🚚 DELIVERY UPDATE: ..." template: "TRACKING NUMBER: <num>"
//     plus "itemId=<id>" in the same tracking-link URL -- matched by
//     ebayItemId, unambiguous.
//   - Some sellers relay their own store's (e.g. Shopify) native shipping
//     email through eBay's buyer-seller messaging: "USPS tracking number:
//     <num>" plus an "ITEMS IN THIS SHIPMENT" section naming the item(s),
//     but NO eBay item ID anywhere in the email. Matched by item name
//     against Purchase.ebayListingName (the raw eBay listing title stored at
//     Upload Purchases time, not the Shopify catalog name) -- see
//     matchByListingName() below. This is inherently less certain than an ID
//     match, so it only ever acts on a single unambiguous best match; a tie
//     between two or more equally-likely purchases raises a Notification for
//     a human to resolve instead of guessing (the exact failure mode that
//     caused a real mismatch earlier in this system).
const Purchase = require("../models/janmarini/Purchase");
const Notification = require("../models/janmarini/Notification");
const { fetchUnseenReceipts } = require("./janmariniMailbox");
const { registerPurchaseWithShipito } = require("./shipitoSync");

const ITEM_ID_RE = /itemId=(\d{9,15})/i;
const TRACKING_NUMBER_RE = /(?:USPS\s*)?tracking\s*number:?\s*(\d{15,26})/i;
const SHIPPED_SIGNAL_PATTERNS = [/order is shipping/i, /package is now with its carrier/i, /has shipped/i];

// Words that carry no product-identifying signal -- sizes, dates, condition
// claims, packaging notes -- common to both eBay listing titles and seller
// shipment-notification item names. Stripping them leaves just the brand +
// product-line tokens that actually distinguish one SKU from another.
const NOISE_WORDS = new Set([
  "jan", "marini", "oz", "ml", "g", "exp", "new", "brand", "in", "box", "nib",
  "authentic", "ship", "fast", "packaging", "the", "a", "of", "for", "with",
  "and", "pack",
]);

function significantTokens(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, " ") // dates like 3/27, 07/28
    .replace(/[^a-z0-9\s%-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NOISE_WORDS.has(w) && !/^\d+$/.test(w));
}

// Extracts {name, quantity} pairs from a "ITEMS IN THIS SHIPMENT ... <name> x
// <qty> ..." style section (seen verbatim in real captured emails).
function extractShipmentItems(text) {
  const section = /items in this shipment([\s\S]*?)(?:if you have any questions|$)/i.exec(text);
  if (!section) return [];
  // Anchored on the Unicode multiplication sign specifically (confirmed
  // against real captured emails) rather than a plain "x"/"X" -- excluding
  // those letters from the name broke on item names containing them (e.g.
  // "EXP 3/27" for an expiration date).
  const items = [];
  const lineRe = /^(.{4,120}?)\s×\s(\d+)\s*$/gm;
  let m;
  while ((m = lineRe.exec(section[1]))) {
    items.push({ name: m[1].trim(), quantity: Number(m[2]) });
  }
  return items;
}

// Scores every "ordered" purchase with a stored ebayListingName against the
// given item name; returns the single best match ONLY if it's unambiguous
// (score >= 2 shared tokens, and strictly higher than every other
// candidate's score). Otherwise returns { tie: [...] } so the caller can
// flag it instead of guessing.
async function matchByListingName(itemName) {
  const needleTokens = significantTokens(itemName);
  if (needleTokens.length < 2) return { match: null, tie: [] };

  const candidates = await Purchase.find({ status: "ordered", ebayListingName: { $ne: "" } }).lean();
  const scored = candidates
    .map((p) => ({ purchase: p, score: significantTokens(p.ebayListingName).filter((t) => needleTokens.includes(t)).length }))
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { match: null, tie: [] };
  const topScore = scored[0].score;
  const tied = scored.filter((s) => s.score === topScore);
  if (tied.length > 1) return { match: null, tie: tied.map((t) => t.purchase) };
  return { match: scored[0].purchase, tie: [] };
}

async function applyTrackingToPurchase(purchase, trackingNumber, details) {
  purchase.sellerTracking = trackingNumber;
  purchase.status = "shipped_by_seller";
  await purchase.save();
  details.push(`${purchase.itemName} (order ${purchase.orderNumber || "stock"}) -- tracking ${trackingNumber}`);

  try {
    await registerPurchaseWithShipito(purchase._id, trackingNumber);
    return true;
  } catch (e) {
    details.push(`  Shipito registration failed: ${e.message}`);
    return false;
  }
}

async function flagAmbiguousMatch(itemName, trackingNumber, tiedPurchases) {
  await Notification.create({
    itemName,
    message: `A shipping email (tracking ${trackingNumber}) named "${itemName}" but matched ${tiedPurchases.length} open purchases equally well (${tiedPurchases.map((p) => `${p.itemName} for ${p.orderNumber || "stock"}`).join(", ")}) -- add the tracking number manually to the right one.`,
    type: "other",
    source: "ebay",
  });
}

async function syncEbayShippedStatus() {
  const { messages, errors } = await fetchUnseenReceipts();
  const ebayMessages = messages.filter((m) => m.source === "ebay");

  let statusUpdated = 0;
  let trackingCaptured = 0;
  let shipitoRegistered = 0;
  let ambiguousFlagged = 0;
  const details = [];

  for (const msg of ebayMessages) {
    const text = `${msg.subject}\n${msg.bodyText}`;
    const trackingMatch = TRACKING_NUMBER_RE.exec(text);
    const idMatch = ITEM_ID_RE.exec(text);

    if (idMatch) {
      const purchase = await Purchase.findOne({ ebayItemId: idMatch[1], status: "ordered" });
      if (purchase) {
        if (trackingMatch) {
          if (await applyTrackingToPurchase(purchase, trackingMatch[1], details)) shipitoRegistered += 1;
          trackingCaptured += 1;
        } else if (SHIPPED_SIGNAL_PATTERNS.some((re) => re.test(text))) {
          purchase.status = "shipped_by_seller";
          purchase.flagNote = purchase.flagNote || `Seller shipped (auto-detected from eBay notification, ${new Date().toISOString().slice(0, 10)}) -- tracking number not present in this email, add manually if needed.`;
          await purchase.save();
          statusUpdated += 1;
        }
        continue;
      }
    }

    // No itemId match (or none present) -- fall back to matching by item
    // name against the "ITEMS IN THIS SHIPMENT" section, only when we
    // actually have a tracking number to act on.
    if (trackingMatch) {
      const shipmentItems = extractShipmentItems(text);
      for (const item of shipmentItems) {
        const { match, tie } = await matchByListingName(item.name);
        if (match) {
          if (await applyTrackingToPurchase(match, trackingMatch[1], details)) shipitoRegistered += 1;
          trackingCaptured += 1;
        } else if (tie.length > 1) {
          await flagAmbiguousMatch(item.name, trackingMatch[1], tie);
          ambiguousFlagged += 1;
        }
      }
    }
  }

  return { checked: ebayMessages.length, statusUpdated, trackingCaptured, shipitoRegistered, ambiguousFlagged, details, mailboxErrors: errors };
}

module.exports = { syncEbayShippedStatus };
