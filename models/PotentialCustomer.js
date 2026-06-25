const mongoose = require("mongoose");

const { Schema } = mongoose;

const SOURCES = ["whatsapp", "meta_ads", "manual", "website", "referral", "other"];
const STATUSES = [
  "new_inquiry", "need_reply", "contacted", "qualified",
  "quotation_needed", "quotation_sent", "won", "lost", "follow_up_later",
];
const PRIORITIES = ["low", "medium", "high", "urgent"];

// Each follow-up logged against a potential customer — powers the timeline on the detail page.
const FollowUpSchema = new Schema(
  {
    note: { type: String, default: "" },
    nextFollowUpDate: { type: Date, default: null },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const PotentialCustomerSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    name: { type: String, required: true, trim: true },
    companyName: { type: String, default: "" },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },

    source: { type: String, enum: SOURCES, default: "manual", index: true },
    interestedService: { type: String, default: "" },
    status: { type: String, enum: STATUSES, default: "new_inquiry", index: true },
    priority: { type: String, enum: PRIORITIES, default: "medium", index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },

    firstMessage: { type: String, default: "" },
    lastMessageAt: { type: Date, default: null },
    nextFollowUpDate: { type: Date, default: null },
    notes: { type: String, default: "" },
    followUps: { type: [FollowUpSchema], default: [] },

    // Conversion linkage (set once converted to a real Customer)
    convertedCustomerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

PotentialCustomerSchema.index({ organization: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PotentialCustomer", PotentialCustomerSchema);
module.exports.PC_SOURCES = SOURCES;
module.exports.PC_STATUSES = STATUSES;
module.exports.PC_PRIORITIES = PRIORITIES;
