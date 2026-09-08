// Wires the Shipito for Business API into the daily sync. Two pieces:
//   1) registerPurchaseWithShipito -- call this once a Purchase has a real
//      sellerTracking number (manually pasted, or a future automated
//      source) to tell Shipito the package is coming.
//   2) syncShipitoStatus -- polls every registered-but-not-yet-arrived
//      Purchase for status updates, and captures the real courier tracking
//      number (often DHL) the moment Shipito ships it onward -- this is
//      what finally closes the "seller tracking -> DHL tracking" gap
//      without a human re-typing anything.
const Purchase = require("../models/janmarini/Purchase");
const InboundShipment = require("../models/janmarini/InboundShipment");
const { createPackage, trackPackage, mapShipitoStatusToInternal } = require("./shipitoApi");

async function registerPurchaseWithShipito(purchaseId, trackingNumber) {
  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw new Error("Purchase not found");
  if (purchase.shipitoReferenceNumber) throw new Error("Already registered with Shipito");

  const referenceNumber = String(purchase._id);
  await createPackage({
    referenceNumber,
    trackingNumber,
    senderName: purchase.seller || "eBay Seller",
    recipientName: "Codex FZE",
    items: [{ itemDescription: purchase.itemName, quantity: purchase.quantity, unitValue: purchase.costUSD }],
  });

  purchase.shipitoReferenceNumber = referenceNumber;
  purchase.sellerTracking = trackingNumber;
  await purchase.save();
  return purchase;
}

// DHL waybills are numeric only (confirmed against the one real one we have:
// "1666564281") -- Shipito's OWN preferred-carrier tracking numbers and
// USPS/other formats look different, so this is a safe, conservative check
// rather than trusting the shippingMethod description string alone.
function looksLikeDhlWaybill(trackingNumber) {
  return /^\d{9,12}$/.test(trackingNumber || "");
}

async function syncShipitoStatus() {
  const purchases = await Purchase.find({
    shipitoReferenceNumber: { $ne: "" },
    status: { $nin: ["delivered", "in_office"] },
  });
  if (!purchases.length) return { checked: 0, updated: 0, skipped: true };

  let updated = 0;
  const errors = [];
  for (const purchase of purchases) {
    try {
      const result = await trackPackage(purchase.shipitoReferenceNumber, true);
      const newStatus = mapShipitoStatusToInternal(result.statusCode);
      if (newStatus && newStatus !== purchase.status) purchase.status = newStatus;

      // Once Shipito hands off to a courier, capture that tracking number and
      // link/create the InboundShipment -- same shape as the DHL integration,
      // so everything downstream (owner dashboard, CRM profit sync) already
      // knows how to read it.
      if (result.trackingNumber && !purchase.inboundShipment) {
        const isDhl = /dhl/i.test(result.shippingMethod || "") || looksLikeDhlWaybill(result.trackingNumber);
        const shipment = await InboundShipment.findOneAndUpdate(
          { snsShipmentNumber: result.trackingNumber },
          { $setOnInsert: { carrier: isDhl ? "dhl" : "shopandship", status: "In Transit" } },
          { upsert: true, new: true }
        );
        purchase.inboundShipment = shipment._id;
      }

      await purchase.save();
      updated += 1;
    } catch (e) {
      errors.push(`${purchase.itemName} (${purchase.shipitoReferenceNumber}): ${e.message}`);
    }
  }
  return { checked: purchases.length, updated, errors, skipped: false };
}

module.exports = { registerPurchaseWithShipito, syncShipitoStatus };
