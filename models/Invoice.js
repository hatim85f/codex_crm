const mongoose = require("mongoose");

const { Schema } = mongoose;

const INVOICE_STATUSES = ["draft", "sent", "partially_paid", "paid", "overdue", "cancelled", "pending_bank_verification"];
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
    billingType: { type: String, default: "one_time" }, // one_time = not ongoing; monthly/quarterly/yearly = recurring
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

const InvoiceSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    invoiceNumber: { type: String, required: true, trim: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: "CustomerContact", default: null },
    quotationId: { type: Schema.Types.ObjectId, ref: "Quotation", default: null, index: true },
    status: { type: String, enum: INVOICE_STATUSES, default: "draft", index: true },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, default: null },
    currency: { type: String, enum: CURRENCIES, required: true, default: "AED" },
    businessLine: { type: String, required: true, trim: true },
    lineItems: { type: [LineItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: DISCOUNT_TYPES, default: "none" },
    discountValue: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0, min: 0 },
    paymentMethod: { type: String, default: "" },
    paymentTerms: { type: String, default: "" },
    depositAmount: { type: Number, default: 0, min: 0 },
    paymentLink: { type: String, default: "" },
    bankAccountId: { type: Schema.Types.ObjectId, ref: "BankAccount", default: null },
    bankTransferReceipt: { type: String, default: "" },
    notes: { type: String, default: "" },
    terms: { type: String, default: "" },
    internalNotes: { type: String, default: "" },
    pdfUrl: { type: String, default: "" },
    emailSentAt: { type: Date, default: null },
    sharedToPortal: { type: Boolean, default: false },
    sharedToPortalAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    sentAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    history: { type: [HistorySchema], default: [] },
  },
  { timestamps: true }
);

InvoiceSchema.index({ organization: 1, invoiceNumber: 1 }, { unique: true });
InvoiceSchema.index({ organization: 1, customerId: 1, createdAt: -1 });
InvoiceSchema.index({ organization: 1, status: 1, businessLine: 1, issueDate: -1 });

module.exports = mongoose.model("Invoice", InvoiceSchema);
module.exports.INVOICE_STATUSES = INVOICE_STATUSES;
module.exports.DISCOUNT_TYPES = DISCOUNT_TYPES;
module.exports.CURRENCIES = CURRENCIES;
