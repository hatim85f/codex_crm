const mongoose = require("mongoose");

const { Schema } = mongoose;

const QUOTATION_STATUSES = ["draft", "sent", "accepted", "rejected", "expired", "cancelled", "converted_to_invoice"];
const DISCOUNT_TYPES = ["none", "fixed", "percentage"];
const CURRENCIES = ["AED", "USD"];

const LineItemSchema = new Schema(
  {
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", default: null },
    serviceName: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    quantity: { type: Number, required: true, min: 0 },
    unitLabel: { type: String, default: "unit", trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, default: "AED" },
    taxable: { type: Boolean, default: true },
    taxRate: { type: Number, default: 0, min: 0 },
    lineSubtotal: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const HistorySchema = new Schema(
  {
    action: { type: String, required: true, trim: true },
    message: { type: String, default: "" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Terms are COPIED into the quotation (not just referenced) so historical quotations
// keep the exact terms approved/sent, even if the source template is edited later.
const TermLineSchema = new Schema(
  {
    termId: { type: Schema.Types.ObjectId, ref: "QuotationTerm", default: null },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    category: { type: String, default: "general" },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const QuotationSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    quotationNumber: { type: String, required: true, trim: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: "CustomerContact", default: null },
    status: { type: String, enum: QUOTATION_STATUSES, default: "draft", index: true },
    issueDate: { type: Date, required: true },
    validUntil: { type: Date, default: null },
    currency: { type: String, enum: CURRENCIES, required: true, default: "AED" },
    businessLine: { type: String, required: true, trim: true },
    lineItems: { type: [LineItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: DISCOUNT_TYPES, default: "none" },
    discountValue: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "" },
    terms: { type: String, default: "" },
    termsAndConditions: { type: [TermLineSchema], default: [] },
    internalNotes: { type: String, default: "" },
    pdfUrl: { type: String, default: "" },
    emailSentAt: { type: Date, default: null },
    sharedToPortal: { type: Boolean, default: false },
    sharedToPortalAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sentAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    convertedToInvoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },
    convertedToProjectId: { type: Schema.Types.ObjectId, default: null },
    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true }
);

QuotationSchema.index({ organization: 1, quotationNumber: 1 }, { unique: true });
QuotationSchema.index({ organization: 1, customerId: 1, createdAt: -1 });
QuotationSchema.index({ organization: 1, status: 1, businessLine: 1, issueDate: -1 });

module.exports = mongoose.model("Quotation", QuotationSchema);
module.exports.QUOTATION_STATUSES = QUOTATION_STATUSES;
module.exports.DISCOUNT_TYPES = DISCOUNT_TYPES;
module.exports.CURRENCIES = CURRENCIES;
