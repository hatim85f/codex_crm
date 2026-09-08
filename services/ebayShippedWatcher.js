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
//     plus "itemId=<id>" in the same tracking-link URL.
//   - Some sellers relay their own store's (e.g. Shopify) native shipping
//     email through eBay's buyer-seller messaging: "USPS tracking number:
//     <num>" plus an "ITEMS IN THIS SHIPMENT" section naming the item(s).
// Matching is done by ebayItemId ONLY (unique per item, set at Upload
// Purchases time) -- never by item name here, to avoid the exact class of
// mismatch bug this system has already been bitten by once.
const Purchase = require("../models/janmarini/Purchase");
const { fetchUnseenReceipts } = require("./janmariniMailbox");
const { registerPurchaseWithShipito } = require("./shipitoSync");

const ITEM_ID_RE = /itemId=(\d{9,15})/i;
const TRACKING_NUMBER_RE = /(?:USPS\s*)?tracking\s*number:?\s*(\d{15,26})/i;
const SHIPPED_SIGNAL_PATTERNS = [/order is shipping/i, /package is now with its carrier/i, /has shipped/i];

async function syncEbayShippedStatus() {
  const { messages, errors } = await fetchUnseenReceipts();
  const ebayMessages = messages.filter((m) => m.source === "ebay");

  let statusUpdated = 0;
  let trackingCaptured = 0;
  let shipitoRegistered = 0;
  const details = [];

  for (const msg of ebayMessages) {
    const text = `${msg.subject}\n${msg.bodyText}`;
    const idMatch = ITEM_ID_RE.exec(text);
    if (!idMatch) continue;
    const ebayItemId = idMatch[1];

    const purchase = await Purchase.findOne({ ebayItemId, status: "ordered" });
    if (!purchase) continue; // no match, or already past this stage -- never move backwards or guess

    const trackingMatch = TRACKING_NUMBER_RE.exec(text);
    if (trackingMatch) {
      const trackingNumber = trackingMatch[1];
      purchase.sellerTracking = trackingNumber;
      purchase.status = "shipped_by_seller";
      await purchase.save();
      trackingCaptured += 1;
      details.push(`${purchase.itemName} (order ${purchase.orderNumber || "stock"}) -- tracking ${trackingNumber}`);

      try {
        await registerPurchaseWithShipito(purchase._id, trackingNumber);
        shipitoRegistered += 1;
      } catch (e) {
        details.push(`  Shipito registration failed: ${e.message}`);
      }
      continue;
    }

    // No tracking number in this particular email -- still worth flipping
    // status if it's a clear "it's shipping now" signal, even without the
    // number (matches the old, more conservative behavior as a fallback).
    if (SHIPPED_SIGNAL_PATTERNS.some((re) => re.test(text))) {
      purchase.status = "shipped_by_seller";
      purchase.flagNote = purchase.flagNote || `Seller shipped (auto-detected from eBay notification, ${new Date().toISOString().slice(0, 10)}) -- tracking number not present in this email, add manually if needed.`;
      await purchase.save();
      statusUpdated += 1;
    }
  }

  return { checked: ebayMessages.length, statusUpdated, trackingCaptured, shipitoRegistered, details, mailboxErrors: errors };
}

module.exports = { syncEbayShippedStatus };
