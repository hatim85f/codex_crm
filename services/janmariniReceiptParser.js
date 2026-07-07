// Reads staged mailbox content (eBay purchase confirmations, Shop & Ship
// screenshots) with Claude vision and extracts structured Purchase/
// InboundShipment data — but NEVER writes it automatically, regardless of
// how confident the model is. Every parsed result lands as
// `awaiting_confirmation` and only gets applied once a human taps confirm
// (see confirmPendingReceipt below, wired to owner-dashboard-facing routes).
// This is deliberate: an unattended pathway that reads customer emails and
// applies the result with no human check is exactly the kind of thing that
// silently corrupts cost/status data — one tap from Hatim replaces that risk
// with near-zero effort on her side while keeping a real human in the loop.
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const Purchase = require("../models/janmarini/Purchase");
const InboundShipment = require("../models/janmarini/InboundShipment");
const PendingReceipt = require("../models/janmarini/PendingReceipt");

const ANTHROPIC_MODEL = process.env.JANMARINI_PARSER_MODEL || "claude-sonnet-5";

const PURCHASE_TOOL = {
  name: "extract_purchase",
  description: "Extract eBay purchase/order details from this receipt or confirmation email so it can be matched to a Shopify order.",
  input_schema: {
    type: "object",
    properties: {
      matchedOrderNumber: { type: "string", description: "Exact Shopify order number from the candidate list (e.g. '#1760') this purchase fulfills, or empty string if none match confidently" },
      itemName: { type: "string", description: "Item name as it should be matched against the Shopify order's line items" },
      quantity: { type: "number" },
      costUSD: { type: "number", description: "Total amount paid in USD for this line (not per-unit unless quantity is 1)" },
      seller: { type: "string" },
      ebayOrderNumber: { type: "string" },
      sellerTracking: { type: "string", description: "Seller/USPS tracking number if present, otherwise empty string" },
      confidence: { type: "string", enum: ["high", "low"] },
      notes: { type: "string", description: "Why confidence is low, any ambiguity, or empty string if none" },
    },
    required: ["confidence", "notes"],
  },
};

const SHIPMENT_TOOL = {
  name: "extract_shipment",
  description: "Extract Shop & Ship (Aramex) shipment tracking details from this screenshot or email.",
  input_schema: {
    type: "object",
    properties: {
      snsShipmentNumber: { type: "string" },
      status: { type: "string", enum: ["At Origin", "In Transit", "At Customs", "At Destination", "Delivered-to-office"] },
      feesAED: { type: "number" },
      feesPaid: { type: "boolean" },
      weight: { type: "number" },
      blockedReason: { type: "string", description: "Fill only if the journey log shows a real blocker (e.g. awaiting customer details for customs) — otherwise empty string" },
      matchedOrderNumbers: { type: "array", items: { type: "string" }, description: "Shopify order number(s) whose items are in this shipment, from the candidate list" },
      confidence: { type: "string", enum: ["high", "low"] },
      notes: { type: "string" },
    },
    required: ["confidence", "notes"],
  },
};

function attachmentBlock(att) {
  const ext = (att.fileName || "").toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
    return { type: "image", source: { type: "url", url: att.url } };
  }
  if (ext === "pdf") {
    return { type: "document", source: { type: "url", url: att.url } };
  }
  return null;
}

async function callClaude(promptText, attachments, tool) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const content = [{ type: "text", text: promptText }];
  for (const att of attachments || []) {
    const block = attachmentBlock(att);
    if (block) content.push(block);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const toolUse = body.content?.find((c) => c.type === "tool_use");
  if (!toolUse) throw new Error("Model did not return a tool call");
  return toolUse.input;
}

async function buildOrderCandidates() {
  const orders = await ShopifyOrder.find({ ignored: false }).select("orderNumber items.name").lean();
  return orders.map((o) => `${o.orderNumber}: ${o.items.map((i) => i.name).join(" / ")}`).join("\n");
}

async function buildUnlinkedPurchaseCandidates() {
  const purchases = await Purchase.find({ inboundShipment: null }).select("orderNumber itemName seller").lean();
  return purchases.map((p) => `${p.orderNumber}: ${p.itemName} (seller: ${p.seller || "?"})`).join("\n");
}

// Reads every still-`pending` receipt with Claude and stores the structured
// result. Read-only against Purchase/InboundShipment — no writes happen here.
async function processPendingReceipts() {
  const pending = await PendingReceipt.find({ status: "pending" });
  let parsed = 0;
  let failed = 0;

  for (const receipt of pending) {
    try {
      const isShipment = receipt.source === "shopandship";
      const candidates = isShipment ? await buildUnlinkedPurchaseCandidates() : await buildOrderCandidates();
      const promptText = [
        `Email subject: ${receipt.subject}`,
        `From: ${receipt.from}`,
        `Body:\n${receipt.bodyText?.slice(0, 4000) || "(no text body)"}`,
        "",
        isShipment
          ? `Candidate purchases awaiting a shipment (orderNumber: item, seller):\n${candidates || "(none)"}`
          : `Candidate Shopify orders (orderNumber: items):\n${candidates || "(none)"}`,
        "",
        "Only set confidence 'high' if you are certain of the match. If the item/order is ambiguous or not in the candidate list, set confidence 'low' and explain in notes.",
      ].join("\n");

      const result = isShipment
        ? await callClaude(promptText, receipt.attachments, SHIPMENT_TOOL)
        : await callClaude(promptText, receipt.attachments, PURCHASE_TOOL);

      receipt.aiConfidence = result.confidence;
      receipt.aiNotes = result.notes || "";
      receipt.aiParsed = result;
      receipt.status = "awaiting_confirmation";
      await receipt.save();
      parsed += 1;
    } catch (e) {
      receipt.status = "awaiting_confirmation";
      receipt.aiConfidence = "low";
      receipt.aiNotes = `Parsing failed: ${e.message}`;
      receipt.aiParsed = null;
      await receipt.save().catch(() => {});
      failed += 1;
    }
  }

  return { total: pending.length, parsed, failed };
}

async function applyPurchaseResult(receipt, parsed) {
  if (!parsed.matchedOrderNumber || !parsed.itemName) {
    return { ok: false, reason: "Parsed result is missing a matched order number or item name — cannot apply." };
  }
  const order = await ShopifyOrder.findOne({ orderNumber: parsed.matchedOrderNumber, ignored: false });
  if (!order) return { ok: false, reason: `Order ${parsed.matchedOrderNumber} not found.` };

  const existing = await Purchase.findOne({
    orderNumber: parsed.matchedOrderNumber,
    itemName: new RegExp(`^${parsed.itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });

  if (existing) {
    if (!existing.costUSD) existing.costUSD = parsed.costUSD || 0;
    if (!existing.seller) existing.seller = parsed.seller || "";
    if (!existing.ebayOrderNumber) existing.ebayOrderNumber = parsed.ebayOrderNumber || "";
    if (!existing.sellerTracking) existing.sellerTracking = parsed.sellerTracking || "";
    if (!existing.receiptFiles?.length) existing.receiptFiles = (receipt.attachments || []).map((a) => a.url);
    if (!existing.purchaseDate) existing.purchaseDate = receipt.receivedAt || new Date();
    await existing.save();
  } else {
    await Purchase.create({
      orderNumber: parsed.matchedOrderNumber,
      itemName: parsed.itemName,
      quantity: parsed.quantity || 1,
      ebayOrderNumber: parsed.ebayOrderNumber || "",
      seller: parsed.seller || "",
      costUSD: parsed.costUSD || 0,
      sellerTracking: parsed.sellerTracking || "",
      purchaseDate: receipt.receivedAt || new Date(),
      receiptFiles: (receipt.attachments || []).map((a) => a.url),
    });
  }
  return { ok: true };
}

async function applyShipmentResult(receipt, parsed) {
  if (!parsed.snsShipmentNumber) {
    return { ok: false, reason: "Parsed result is missing a Shop & Ship shipment number — cannot apply." };
  }

  const existing = await InboundShipment.findOne({ snsShipmentNumber: parsed.snsShipmentNumber });
  const now = new Date();
  const update = {
    seller: parsed.seller || existing?.seller || "",
    weight: parsed.weight || existing?.weight || 0,
    feesAED: parsed.feesAED ?? existing?.feesAED ?? 0,
    feesPaid: parsed.feesPaid ?? existing?.feesPaid ?? false,
    status: parsed.status || existing?.status || "At Origin",
    lastTrackingCheck: now,
    blockedReason: parsed.blockedReason || "",
  };
  if (update.feesPaid && !existing?.feesPaidDate) update.feesPaidDate = now;
  if (update.status === "At Destination" && !existing?.atDestinationDate) update.atDestinationDate = now;
  if (update.status === "Delivered-to-office" && !existing?.deliveredDate) update.deliveredDate = now;

  const shipment = await InboundShipment.findOneAndUpdate(
    { snsShipmentNumber: parsed.snsShipmentNumber },
    update,
    { upsert: true, new: true }
  );

  if (parsed.matchedOrderNumbers?.length) {
    await Purchase.updateMany(
      { orderNumber: { $in: parsed.matchedOrderNumbers }, inboundShipment: null },
      { inboundShipment: shipment._id }
    );
  }
  return { ok: true };
}

// The ONLY place a PendingReceipt's parsed data actually gets written to
// Purchase/InboundShipment — called from an owner-authenticated "confirm" tap,
// never automatically.
async function confirmPendingReceipt(receiptId) {
  const receipt = await PendingReceipt.findById(receiptId);
  if (!receipt) throw new Error("Pending receipt not found");
  if (receipt.status !== "awaiting_confirmation") throw new Error(`Cannot confirm a receipt with status "${receipt.status}"`);
  if (!receipt.aiParsed) throw new Error("No parsed data to confirm");

  const isShipment = receipt.source === "shopandship";
  const result = isShipment
    ? await applyShipmentResult(receipt, receipt.aiParsed)
    : await applyPurchaseResult(receipt, receipt.aiParsed);

  if (!result.ok) throw new Error(result.reason);

  receipt.status = "processed";
  await receipt.save();
  return receipt;
}

async function rejectPendingReceipt(receiptId) {
  const receipt = await PendingReceipt.findById(receiptId);
  if (!receipt) throw new Error("Pending receipt not found");
  receipt.status = "ignored";
  await receipt.save();
  return receipt;
}

module.exports = { processPendingReceipts, confirmPendingReceipt, rejectPendingReceipt };
