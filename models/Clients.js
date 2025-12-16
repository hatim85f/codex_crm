const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ClientsSchema = Schema(
  {
    firstName: {
      type: String,
      required: true,
    },
    lastName: {
      type: String,
      required: true,
    },
    displayName: {
      type: String,
      default: function () {
        return this.firstName + " " + this.lastName;
      },
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    phoneE164: {
      type: String,
      trim: true,
      index: true,
    },
    whatsAppNumber: {
      type: String,
      required: true,
      trim: true,
    },
    whatsAppE164: {
      type: String,
      trim: true,
      index: true,
    },
    waId: {
      type: String,
      trim: true,
      index: true,
    },
    country: {
      type: String,
      required: true,
    },
    companyName: {
      type: String,
      required: false,
    },
    companyLogo: {
      type: String,
      required: false,
    },
    profilePicture: {
      type: String,
      required: false,
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    source: {
      type: String,
      required: true,
      enum: ["manual", "whatsapp", "facebook", "google"],
    },
    handledBy: {
      type: Schema.Types.ObjectId,
      ref: "users",
    },
    // relations
    projects: [
      {
        type: Schema.Types.ObjectId,
        ref: "projects",
      },
    ],
    payments: [
      {
        amount: {
          type: Number,
          required: true,
        },
        date: {
          type: Date,
          required: true,
        },
        method: {
          type: String,
          required: true,
        },
        transactionId: {
          type: String,
          required: false,
        },
      },
    ],
    quotations: [
      {
        type: Schema.Types.ObjectId,
        ref: "quotations",
      },
    ],
    invoices: [
      {
        type: Schema.Types.ObjectId,
        ref: "invoices",
      },
    ],
    // ✅ activity tracking
    lastMessageAt: { type: Date, default: null, index: true },
    lastActivityAt: { type: Date, default: null, index: true },
    // ✅ light CRM extras
    tags: { type: [String], default: [] },
    assignedTo: { type: Schema.Types.ObjectId, ref: "users" },
    // ✅ who created it manually (useful later)
    createdBy: { type: Schema.Types.ObjectId, ref: "users" },
    clientFor: {
      type: Schema.Types.ObjectId,
      ref: "organization",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// ✅ Multi-tenant uniqueness
ClientsSchema.index({ clientFor: 1, email: 1 }, { unique: true });
ClientsSchema.index(
  { clientFor: 1, phoneE164: 1 },
  { unique: true, sparse: true }
);
ClientsSchema.index(
  { clientFor: 1, whatsAppE164: 1 },
  { unique: true, sparse: true }
);

// helpful filters
ClientsSchema.index({ clientFor: 1, assignedTo: 1, status: 1 });
ClientsSchema.index({ clientFor: 1, lastActivityAt: -1 });

module.exports = Clients = mongoose.model("clients", ClientsSchema);
