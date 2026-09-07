// Narrow, deterministic watcher: ONLY looks for eBay "your order is
// shipping" notifications and flips the matching Purchase to
// "shipped_by_seller". Does NOT extract a tracking number -- checked against
// real captured emails and eBay's notification body never contains one as
// plain text, only a "Track order" link that requires an eBay login to
// resolve. So this automates the STATUS transition only; the actual seller
// tracking number still has to be pasted in by hand (or fetched via a real
// eBay Developer API integration, which is a separate, bigger project).
//
// Matches by ebayItemId (the listing id eBay's email embeds in its tracking
// link, e.g. "itemId=407165878999") rather than ebayOrderNumber, since one
// eBay checkout can cover multiple items/orders but this id is unique per
// item -- no ambiguity risk the way name/order matching had.
const { fetchUnseenReceipts } = require("./janmariniMailbox");
const Purchase = require("../models/janmarini/Purchase");

const ITEM_ID_RE = /itemId=(\d{9,15})/i;
const SHIPPED_BODY_PATTERNS = [/order is shipping/i, /package is now with its carrier/i, /has shipped/i];

async function syncEbayShippedStatus() {
  const { messages, errors } = await fetchUnseenReceipts();
  const ebayMessages = messages.filter((m) => m.source === "ebay");

  let updated = 0;
  const details = [];
  for (const msg of ebayMessages) {
    const text = `${msg.subject}\n${msg.bodyText}`;
    if (!SHIPPED_BODY_PATTERNS.some((re) => re.test(text))) continue;

    const idMatch = ITEM_ID_RE.exec(text);
    if (!idMatch) continue;
    const ebayItemId = idMatch[1];

    const purchase = await Purchase.findOne({ ebayItemId, status: "ordered" });
    if (!purchase) continue; // no match, or already past this stage -- never move backwards or guess

    purchase.status = "shipped_by_seller";
    purchase.flagNote = purchase.flagNote || `Seller shipped (auto-detected from eBay notification, ${new Date().toISOString().slice(0, 10)}) -- tracking number not available from email, add manually if needed.`;
    await purchase.save();
    updated += 1;
    details.push(`${purchase.itemName} (order ${purchase.orderNumber || "stock"})`);
  }

  return { checked: ebayMessages.length, updated, details, mailboxErrors: errors };
}

module.exports = { syncEbayShippedStatus };
