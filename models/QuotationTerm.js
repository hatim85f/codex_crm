const mongoose = require("mongoose");

const { Schema } = mongoose;

// Reusable, manageable quotation terms & conditions. These are *templates*: when a
// quotation is created the selected terms are COPIED into the quotation document, so
// editing a template here never changes terms on already-saved quotations.
const QuotationTermSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    categories: { type: [String], default: ["general"] }, // a term can belong to several categories

    appliesToServices: [{ type: Schema.Types.ObjectId, ref: "Service" }],
    appliesToServiceCategories: [{ type: Schema.Types.ObjectId, ref: "ServiceCategory" }],
    businessLine: { type: String, default: "", trim: true },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

QuotationTermSchema.index({ organization: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("QuotationTerm", QuotationTermSchema);
