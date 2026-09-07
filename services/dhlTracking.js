// DHL Shipment Tracking - Unified API. Free tier: 250 calls/day, max 1 call
// per 5 seconds -- fine for our volume (a handful of DHL shipments at a
// time), but callers should still avoid tight loops.
const DHL_API_BASE = "https://api-eu.dhl.com/track/shipments";

async function trackDhlShipment(trackingNumber) {
  const apiKey = process.env.DHL_API_KEY;
  if (!apiKey) throw new Error("DHL_API_KEY not configured");

  const res = await fetch(`${DHL_API_BASE}?trackingNumber=${encodeURIComponent(trackingNumber)}`, {
    headers: { "DHL-API-Key": apiKey },
  });
  if (res.status === 404) return null; // not found yet (can happen right after payment/label creation)
  if (!res.ok) throw new Error(`DHL tracking API returned ${res.status}`);

  const data = await res.json();
  const shipment = data.shipments?.[0];
  if (!shipment) return null;

  const statusCode = shipment.status?.statusCode || "unknown"; // pre-transit | transit | delivered | failure | unknown
  const statusDescription = shipment.status?.description || "";
  const timestamp = shipment.status?.timestamp ? new Date(shipment.status.timestamp) : null;
  // Only flag "at customs" from the CURRENT status, and only while clearance
  // is still in progress -- once DHL says clearance is complete/released, the
  // shipment has moved on even though an earlier event still mentions customs.
  const isAtCustoms = /customs|clearance/i.test(statusDescription) && !/complete|cleared|released/i.test(statusDescription);

  return { statusCode, statusDescription, timestamp, isAtCustoms, raw: shipment };
}

// Map DHL's own status vocabulary onto our internal InboundShipment.STATUSES.
function mapDhlStatusToInternal(dhlResult) {
  if (!dhlResult) return null;
  if (dhlResult.statusCode === "delivered") return "Delivered-to-office";
  if (dhlResult.isAtCustoms) return "At Customs";
  if (dhlResult.statusCode === "transit") return "In Transit";
  if (dhlResult.statusCode === "pre-transit") return "At Origin";
  return null; // "failure" / "unknown" -- leave status untouched, don't guess
}

module.exports = { trackDhlShipment, mapDhlStatusToInternal };
