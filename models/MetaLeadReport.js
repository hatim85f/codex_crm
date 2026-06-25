const mongoose = require("mongoose");

const { Schema } = mongoose;

const STATUSES = [
  "new", "contacted", "qualified", "converted_to_potential_customer",
  "ignored", "duplicate", "invalid",
];

// A single answer from the Meta lead form (question -> value).
const FieldDataSchema = new Schema(
  {
    name: { type: String, default: "" },
    label: { type: String, default: "" },
    value: { type: String, default: "" },
  },
  { _id: false }
);

const MetaLeadReportSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    metaLeadId: { type: String, default: "", index: true }, // leadgen_id from Meta (dedupe)
    pageId: { type: String, default: "" },
    formId: { type: String, default: "" },
    adId: { type: String, default: "" },
    adName: { type: String, default: "" },
    campaignId: { type: String, default: "" },
    campaignName: { type: String, default: "" },
    submittedAt: { type: Date, default: null },

    fullName: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    fieldData: { type: [FieldDataSchema], default: [] },

    status: { type: String, enum: STATUSES, default: "new", index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },

    // Conversion / linkage (set manually by an internal user — never automatic)
    linkedPotentialCustomerId: { type: Schema.Types.ObjectId, ref: "PotentialCustomer", default: null, index: true },
    linkedCustomerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },

    notes: { type: String, default: "" },
    rawPayload: { type: Schema.Types.Mixed, default: null },
    isDuplicate: { type: Boolean, default: false, index: true },
    duplicateOf: { type: Schema.Types.ObjectId, ref: "MetaLeadReport", default: null },
  },
  { timestamps: true }
);

MetaLeadReportSchema.index({ organization: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model("MetaLeadReport", MetaLeadReportSchema);
module.exports.META_LEAD_STATUSES = STATUSES;
