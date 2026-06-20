const mongoose = require("mongoose");

const { Schema } = mongoose;

const BUSINESS_LINES = [
  "Software Development",
  "Marketing Services",
  "Media Production",
  "eCommerce",
  "Dropshipping",
  "Hosting / Maintenance",
  "Other",
];

const ServiceCategorySchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    businessLine: { type: String, enum: BUSINESS_LINES, default: "Other" },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

ServiceCategorySchema.index({ organization: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("ServiceCategory", ServiceCategorySchema);
module.exports.BUSINESS_LINES = BUSINESS_LINES;
