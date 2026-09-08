// Shipito For Business API client (spec: shipito.com/documents/ShipitoForBusinessAPIDocumentation.pdf,
// Oct 23 2024). REST + JSON, credentials included in every request body (not
// a header) -- see Credentials object in the spec.
const BASE_URL = "https://www.shipito.com/apis/REST";

function credentials() {
  const APIUser = process.env.SHIPITO_API_USER;
  const APIKey = process.env.SHIPITO_API_KEY;
  if (!APIUser || !APIKey) throw new Error("SHIPITO_API_USER/SHIPITO_API_KEY not configured");
  return { APIUser, APIKey };
}

async function callMethod(methodName, body) {
  const res = await fetch(`${BASE_URL}/${methodName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentials: credentials(), ...body }),
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`Shipito ${methodName} failed (${data.error?.errorCode}): ${data.error?.errorMessage}`);
  }
  return data;
}

// Registers an inbound package with Shipito BEFORE it arrives, using the
// seller's own tracking number so Shipito's warehouse can match it on
// arrival. referenceNumber is OUR id (Purchase._id) -- Shipito's system uses
// it for every subsequent call about this package.
async function createPackage({ referenceNumber, trackingNumber, senderName, recipientName, weightLb, items }) {
  return callMethod("createPackage", {
    referenceNumber,
    trackingNumber,
    senderName: senderName || "eBay Seller",
    recipientName: recipientName || "Codex FZE",
    packageWeight: { weight: weightLb || 1, units: "lb" },
    items: items.map((i) => ({
      itemDescription: i.itemDescription.slice(0, 150),
      quantity: i.quantity || 1,
      unitValue: { amount: i.unitValue || 0, currencyCode: "USD" },
    })),
  });
}

async function getPackageStatus(referenceNumber) {
  return callMethod("getPackageStatus", { referenceNumber });
}

async function trackPackage(referenceNumber, includeDetails = false) {
  return callMethod("trackPackage", { referenceNumber, includeDetails });
}

async function requestConsolidation({ referenceNumbers, shipOption, packOption, shippingInfo }) {
  return callMethod("requestConsolidation", { referenceNumbers, shipOption, packOption, shippingInfo });
}

// Maps Shipito's trackPackage/getPackageStatus statusCode onto Purchase.STATUSES.
// See Appendix > Status Codes in the API spec.
function mapShipitoStatusToInternal(statusCode) {
  if (statusCode === 80) return "delivered"; // DELIVERED (to end consignee -- only relevant if we ever ship-from-Shipito directly to a customer)
  if (statusCode === 60) return "in_transit_to_dubai"; // SHIPPED (out of Shipito's warehouse)
  if (statusCode === 40) return "at_shop_and_ship"; // CONSOLIDATED
  if ([20, 30].includes(statusCode)) return "at_shop_and_ship"; // RECEIVING / ACTION REQUIRED -- physically at the warehouse
  if (statusCode === 10) return "shipped_by_seller"; // INCOMING -- still enroute to Shipito, but Shipito already knows about it
  return null; // STORAGE_EXPIRED / DISPOSED / CANCELLED -- needs a human look, never auto-set
}

module.exports = { createPackage, getPackageStatus, trackPackage, requestConsolidation, mapShipitoStatusToInternal };
