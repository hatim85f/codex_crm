const mongoose = require("mongoose");

const { Schema } = mongoose;

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
    // Future relationship placeholders (projects/invoices/payments/support/files)
    // are intentionally NOT modeled yet — added in later steps.
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", CustomerSchema);
