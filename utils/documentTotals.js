const mongoose = require("mongoose");

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function validateDiscount(discountType = "none", discountValue = 0) {
  const type = ["none", "fixed", "percentage"].includes(discountType) ? discountType : "none";
  const value = normalizeNumber(discountValue, 0);
  if (value < 0) throw new Error("Discount cannot be negative");
  if (type === "percentage" && value > 100) throw new Error("Percentage discount cannot exceed 100");
  return { discountType: type, discountValue: type === "none" ? 0 : value };
}

function calculateLineItem(item = {}, index = 0) {
  const quantity = normalizeNumber(item.quantity, 0);
  const unitPrice = normalizeNumber(item.unitPrice, 0);
  const taxRate = normalizeNumber(item.taxRate, 0);
  if (quantity <= 0) throw new Error("Line item quantity must be greater than 0");
  if (unitPrice < 0) throw new Error("Line item unit price cannot be negative");
  if (taxRate < 0) throw new Error("Line item tax rate cannot be negative");
  const taxable = !!item.taxable;
  const lineSubtotal = roundMoney(quantity * unitPrice);
  const taxAmount = taxable ? roundMoney((lineSubtotal * taxRate) / 100) : 0;
  const lineTotal = roundMoney(lineSubtotal + taxAmount);
  return {
    serviceId: item.serviceId && mongoose.Types.ObjectId.isValid(item.serviceId) ? item.serviceId : null,
    serviceName: String(item.serviceName || "").trim(),
    description: item.description || "",
    quantity,
    unitLabel: item.unitLabel || "unit",
    unitPrice,
    currency: item.currency || "AED",
    taxable,
    taxRate: taxable ? taxRate : 0,
    lineSubtotal,
    taxAmount,
    lineTotal,
    sortOrder: normalizeNumber(item.sortOrder, index),
  };
}

function calculateDocument(lineItems = [], discountType = "none", discountValue = 0) {
  if (!Array.isArray(lineItems) || !lineItems.length) throw new Error("At least one line item is required");
  const normalizedItems = lineItems.map((item, index) => calculateLineItem(item, index));
  const discount = validateDiscount(discountType, discountValue);
  const subtotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.lineSubtotal, 0));
  const taxTotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.taxAmount, 0));
  const discountAmount = discount.discountType === "fixed"
    ? roundMoney(Math.min(discount.discountValue, subtotal))
    : discount.discountType === "percentage"
      ? roundMoney((subtotal * discount.discountValue) / 100)
      : 0;
  const grandTotal = roundMoney(Math.max(0, subtotal - discountAmount + taxTotal));
  return {
    lineItems: normalizedItems,
    discountType: discount.discountType,
    discountValue: discount.discountValue,
    subtotal,
    discountAmount,
    taxTotal,
    grandTotal,
  };
}

module.exports = {
  roundMoney,
  calculateDocument,
};
