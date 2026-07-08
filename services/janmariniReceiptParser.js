// Reads staged mailbox content (eBay purchase confirmations, Shop & Ship
// screenshots) with Claude vision and extracts structured Purchase/
// InboundShipment data — but NEVER writes it automatically, regardless of
// how confident the model is. Every parsed result lands as
// `awaiting_confirmation` and only gets applied once a human taps confirm
// (see confirmPendingReceipt below, wired to owner-dashboard-facing routes).
// This is deliberate: an unattended pathway that reads customer emails and
// applies the result with no human check is exactly the kind of thing that
// silently corrupts cost/status data — one tap replaces that risk with
// near-zero effort while keeping a real human in the loop.
//
// One email/screenshot batch can genuinely cover MULTIPLE purchases or
// shipment boxes (e.g. a "Shop & Ship Updates" email with 10 screenshots of
// 10 different boxes). Earlier this only extracted a single "best guess" and
// dumped everything else into a text note for a human to manually re-enter —
// that defeated the point of automating this. Now it extracts an ARRAY and
// the one Confirm tap applies every clearly-identified item/box at once;
// only genuinely unmatched pieces are left out (noted, not silently dropped).
const ShopifyOrder = require("../models/janmarini/ShopifyOrder");
const Purchase = require("../models/janmarini/Purchase");
const InboundShipment = require("../models/janmarini/InboundShipment");
const PendingReceipt = require("../models/janmarini/PendingReceipt");

const ANTHROPIC_MODEL = process.env.JANMARINI_PARSER_MODEL || "claude-sonnet-5";

// mariniorders@ now receives BOTH eBay purchase receipts AND Shop&Ship
// screenshots (Hatim sends everything there) — so unlike the "ebay" and
// "shopandship" mailbox sources, content type can't be inferred from the
// mailbox alone. This classifies first, then routes to the right extraction
// tool.
const CLASSIFY_TOOL = {
  name: "classify_content",
  description: "Determine whether this email/attachment is an eBay purchase receipt/confirmation, or a Shop & Ship (Aramex) shipment screenshot.",
  input_schema: {
    type: "object",
    properties: {
      contentType: { type: "string", enum: ["purchase", "shipment", "unclear"] },
    },
    required: ["contentType"],
  },
};

const PURCHASE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    matchedOrderNumber: { type: "string", description: "Exact Shopify order number from the candidate list (e.g. '#1760'), or empty string if none match confidently" },
    itemName: { type: "string", description: "Item name copied EXACTLY (character-for-character) from the matched candidate order's item list — never paraphrase, it's used for an exact-match lookup" },
    quantity: { type: "number" },
    costUSD: { type: "number", description: "Total amount paid in USD for this line (not per-unit unless quantity is 1); 0 if not shown" },
    seller: { type: "string" },
    ebayOrderNumber: { type: "string" },
    sellerTracking: { type: "string", description: "Seller/USPS tracking number if present, otherwise empty string" },
    confidence: { type: "string", enum: ["high", "low"] },
    notes: { type: "string", description: "Why confidence is low, any ambiguity, or empty string if none" },
  },
  required: ["confidence", "notes"],
};

const PURCHASE_TOOL = {
  name: "extract_purchases",
  description: "Extract every distinct eBay purchase/order line item from this receipt or confirmation email so each can be matched to a Shopify order. A single email can cover multiple items/orders bought in one checkout — list ALL of them, not just one.",
  input_schema: {
    type: "object",
    properties: {
      items: { type: "array", items: PURCHASE_ITEM_SCHEMA, description: "One entry per distinct item/line found. Empty array if nothing extractable." },
    },
    required: ["items"],
  },
};

const SHIPMENT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    snsShipmentNumber: { type: "string" },
    status: { type: "string", enum: ["At Origin", "In Transit", "At Customs", "At Destination", "Delivered-to-office"] },
    feesAED: { type: "number" },
    feesPaid: { type: "boolean" },
    weight: { type: "number" },
    blockedReason: { type: "string", description: "Fill only if the journey log shows a real blocker (e.g. awaiting customer details for customs) — otherwise empty string" },
    matchedOrderNumbers: { type: "array", items: { type: "string" }, description: "Shopify order number(s) whose items are in this box, from the candidate list — empty array if no confident match" },
    confidence: { type: "string", enum: ["high", "low"] },
    notes: { type: "string" },
  },
  required: ["confidence", "notes"],
};

const SHIPMENT_TOOL = {
  name: "extract_shipments",
  description: "Extract every distinct Shop & Ship (Aramex) shipment box found across this email's screenshot(s). A single email can contain screenshots of several different boxes — list ALL of them, not just one.",
  input_schema: {
    type: "object",
    properties: {
      shipments: { type: "array", items: SHIPMENT_ITEM_SCHEMA, description: "One entry per distinct box/tracking number found. Empty array if nothing extractable." },
    },
    required: ["shipments"],
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
      max_tokens: 4096,
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

function basePromptLines(receipt) {
  return [
    `Email subject: ${receipt.subject}`,
    `From: ${receipt.from}`,
    `Body:\n${receipt.bodyText?.slice(0, 4000) || "(no text body)"}`,
  ];
}

// mariniorders@ receives both eBay bills and Shop&Ship screenshots now, so
// content type can't be assumed from the mailbox — ask the model first.
async function classifyContentType(receipt) {
  const promptText = [...basePromptLines(receipt), "", "Is this an eBay purchase receipt/confirmation, or a Shop & Ship shipment screenshot/update?"].join("\n");
  const result = await callClaude(promptText, receipt.attachments, CLASSIFY_TOOL);
  return result.contentType;
}

function overallConfidence(list) {
  return list.length && list.every((x) => x.confidence === "high") ? "high" : "low";
}

// Reads every still-`pending` receipt with Claude and stores the structured
// result (an array of items/shipments, not just one). Read-only against
// Purchase/InboundShipment — no writes happen here.
async function processPendingReceipts() {
  const pending = await PendingReceipt.find({ status: "pending" });
  let parsed = 0;
  let failed = 0;

  for (const receipt of pending) {
    try {
      let isShipment;
      if (receipt.source === "shopandship") isShipment = true;
      else if (receipt.source === "ebay") isShipment = false;
      else isShipment = (await classifyContentType(receipt)) === "shipment"; // "mariniorders" — ambiguous, classify

      const candidates = isShipment ? await buildUnlinkedPurchaseCandidates() : await buildOrderCandidates();
      const promptText = [
        ...basePromptLines(receipt),
        "",
        isShipment
          ? `Candidate purchases awaiting a shipment (orderNumber: item, seller):\n${candidates || "(none)"}`
          : `Candidate Shopify orders (orderNumber: items):\n${candidates || "(none)"}`,
        "",
        "List EVERY distinct item/box found, not just one — a single email can cover several. Only set an individual entry's confidence to 'high' if you are certain of its match; use 'low' and explain in its notes if ambiguous.",
      ].join("\n");

      const result = isShipment
        ? await callClaude(promptText, receipt.attachments, SHIPMENT_TOOL)
        : await callClaude(promptText, receipt.attachments, PURCHASE_TOOL);

      const list = isShipment ? result.shipments || [] : result.items || [];
      receipt.aiConfidence = overallConfidence(list);
      receipt.aiNotes = list.length > 1 ? `Covers ${list.length} distinct ${isShipment ? "shipment box(es)" : "item(s)"}.` : "";
      receipt.aiParsed = { list, contentType: isShipment ? "shipment" : "purchase" };
      receipt.status = "awaiting_confirmation";
      await receipt.save();
      parsed += 1;
    } catch (e) {
      // A technical failure (API error, credit balance, network) is NOT the
      // same as "nothing found in this email" — surfacing it as an
      // awaiting_confirmation card with no data is actively misleading
      // (it reads as "confirmed nothing here" when the truth is "couldn't
      // even try"). Leave it `pending` so the next scheduled run retries it
      // automatically once whatever broke is fixed; only the failure reason
      // is recorded for visibility if someone checks the raw data.
      receipt.aiNotes = `Parsing failed, will retry next run: ${e.message}`;
      await receipt.save().catch(() => {});
      failed += 1;
    }
  }

  return { total: pending.length, parsed, failed };
}

async function applyOnePurchase(receipt, item) {
  if (!item.matchedOrderNumber || !item.itemName) {
    return { ok: false, reason: "missing matched order number or item name" };
  }
  const order = await ShopifyOrder.findOne({ orderNumber: item.matchedOrderNumber, ignored: false });
  if (!order) return { ok: false, reason: `order ${item.matchedOrderNumber} not found` };

  const existing = await Purchase.findOne({
    orderNumber: item.matchedOrderNumber,
    itemName: new RegExp(`^${item.itemName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });

  if (existing) {
    if (!existing.costUSD) existing.costUSD = item.costUSD || 0;
    if (!existing.seller) existing.seller = item.seller || "";
    if (!existing.ebayOrderNumber) existing.ebayOrderNumber = item.ebayOrderNumber || "";
    if (!existing.sellerTracking) existing.sellerTracking = item.sellerTracking || "";
    if (!existing.purchaseDate) existing.purchaseDate = receipt.receivedAt || new Date();
    await existing.save();
  } else {
    await Purchase.create({
      orderNumber: item.matchedOrderNumber,
      itemName: item.itemName,
      quantity: item.quantity || 1,
      ebayOrderNumber: item.ebayOrderNumber || "",
      seller: item.seller || "",
      costUSD: item.costUSD || 0,
      sellerTracking: item.sellerTracking || "",
      purchaseDate: receipt.receivedAt || new Date(),
      receiptFiles: (receipt.attachments || []).map((a) => a.url),
    });
  }
  return { ok: true };
}

async function applyOneShipment(receipt, item) {
  if (!item.snsShipmentNumber) return { ok: false, reason: "missing Shop & Ship shipment number" };

  const existing = await InboundShipment.findOne({ snsShipmentNumber: item.snsShipmentNumber });
  const now = new Date();
  const update = {
    seller: item.seller || existing?.seller || "",
    weight: item.weight || existing?.weight || 0,
    feesAED: item.feesAED ?? existing?.feesAED ?? 0,
    feesPaid: item.feesPaid ?? existing?.feesPaid ?? false,
    status: item.status || existing?.status || "At Origin",
    lastTrackingCheck: now,
    blockedReason: item.blockedReason || "",
  };
  if (update.feesPaid && !existing?.feesPaidDate) update.feesPaidDate = now;
  if (update.status === "At Destination" && !existing?.atDestinationDate) update.atDestinationDate = now;
  if (update.status === "Delivered-to-office" && !existing?.deliveredDate) update.deliveredDate = now;

  const shipment = await InboundShipment.findOneAndUpdate(
    { snsShipmentNumber: item.snsShipmentNumber },
    update,
    { upsert: true, new: true }
  );

  if (item.matchedOrderNumbers?.length) {
    await Purchase.updateMany(
      { orderNumber: { $in: item.matchedOrderNumbers }, inboundShipment: null },
      { inboundShipment: shipment._id }
    );
  }
  return { ok: true };
}

// The ONLY place a PendingReceipt's parsed data actually gets written to
// Purchase/InboundShipment — called from an owner-authenticated "confirm" tap,
// never automatically. Applies EVERY identified item/box in one go; anything
// that couldn't be matched is skipped (not silently discarded — reflected in
// the returned skipped count) rather than blocking the whole confirm.
async function confirmPendingReceipt(receiptId) {
  const receipt = await PendingReceipt.findById(receiptId);
  if (!receipt) throw new Error("Pending receipt not found");
  if (receipt.status !== "awaiting_confirmation") throw new Error(`Cannot confirm a receipt with status "${receipt.status}"`);
  if (!receipt.aiParsed) throw new Error("No parsed data to confirm");

  const isShipment = receipt.aiParsed.contentType === "shipment";
  const list = receipt.aiParsed.list || (receipt.aiParsed.snsShipmentNumber || receipt.aiParsed.matchedOrderNumber ? [receipt.aiParsed] : []); // fall back for older single-item aiParsed shape

  let applied = 0;
  let skipped = 0;
  for (const item of list) {
    const result = isShipment ? await applyOneShipment(receipt, item) : await applyOnePurchase(receipt, item);
    if (result.ok) applied += 1;
    else skipped += 1;
  }

  if (applied === 0 && list.length > 0) {
    throw new Error(`Could not apply any of the ${list.length} item(s) — none matched a known order.`);
  }
  if (list.length === 0) {
    throw new Error("No items/boxes were extracted from this receipt.");
  }

  receipt.status = "processed";
  await receipt.save();
  return { receipt, applied, skipped, total: list.length };
}

async function rejectPendingReceipt(receiptId) {
  const receipt = await PendingReceipt.findById(receiptId);
  if (!receipt) throw new Error("Pending receipt not found");
  receipt.status = "ignored";
  await receipt.save();
  return receipt;
}

module.exports = { processPendingReceipts, confirmPendingReceipt, rejectPendingReceipt };
