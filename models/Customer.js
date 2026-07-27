const mongoose = require("mongoose");

const { Schema } = mongoose;

// A customer can have multiple projects that need to be invoiced/quoted to a different
// billing name/address/TRN (e.g. different subsidiaries of the same client). Each profile
// gets its own _id (default Mongoose behavior) so it can be selected per quotation/invoice.
const BillingProfileSchema = new Schema(
  {
    label: { type: String, required: true, trim: true }, // e.g. "Project Alpha HQ"
    companyName: { type: String, default: "" },
    address: { type: String, default: "" },
    taxNumber: { type: String, default: "" },
    contactEmail: { type: String, default: "", lowercase: true, trim: true },
    contactPhone: { type: String, default: "" },
  },
  { timestamps: true }
);

const CustomerSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    type: { type: String, enum: ["company", "individual"], default: "company" },

    // Basic
    displayName: { type: String, required: true, trim: true },
    logo: { type: String, default: "" }, // Cloudinary secure_url
    companyName: { type: String, default: "" },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    businessLine: { type: String, default: "" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null }, // primary owner
    assignees: [{ type: Schema.Types.ObjectId, ref: "User" }], // additional assigned team members
    teams: [{ type: Schema.Types.ObjectId, ref: "Team" }], // connected teams

    // Contact
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },

    // Tax / billing
    tax: {
      taxNumber: { type: String, default: "" },
      billingEmail: { type: String, default: "" },
      billingAddress: { type: String, default: "" },
    },

    // Online presence
    online: {
      website: { type: String, default: "" },
      linkedin: { type: String, default: "" },
      instagram: { type: String, default: "" },
      facebook: { type: String, default: "" },
      x: { type: String, default: "" },
    },

    notes: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },

    // Named billing profiles (different subsidiary/project billing name/address/TRN)
    // that can be picked per quotation/invoice instead of this customer's own tax info.
    billingProfiles: { type: [BillingProfileSchema], default: [] },
    // Future relationship placeholders (projects/invoices/payments/support/files)
    // are intentionally NOT modeled yet — added in later steps.
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", CustomerSchema);
