const mongoose = require("mongoose");

const { Schema } = mongoose;

const OrganizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    logo: { type: String, default: "" }, // Cloudinary secure_url
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    contactEmail: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    address: { type: String, default: "" },
    taxNumber: { type: String, default: "" }, // Codex TRN, shown on quotations/invoices
  },
  { timestamps: true }
);

module.exports = mongoose.model("Organization", OrganizationSchema);
