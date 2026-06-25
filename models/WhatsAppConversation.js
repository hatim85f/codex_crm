const mongoose = require("mongoose");

const { Schema } = mongoose;

const STATUSES = ["open", "pending", "resolved", "archived"];

const WhatsAppConversationSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },

    phoneNumber: { type: String, required: true, index: true },
    customerName: { type: String, default: "" },

    // Linkage — a WhatsApp thread usually belongs to a potential customer, and once
    // that lead is converted, to a real customer too.
    potentialCustomerId: { type: Schema.Types.ObjectId, ref: "PotentialCustomer", default: null, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },

    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    status: { type: String, enum: STATUSES, default: "open", index: true },

    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "" },
    unreadCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

WhatsAppConversationSchema.index({ organization: 1, lastMessageAt: -1 });

module.exports = mongoose.model("WhatsAppConversation", WhatsAppConversationSchema);
module.exports.WA_CONV_STATUSES = STATUSES;
