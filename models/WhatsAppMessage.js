const mongoose = require("mongoose");

const { Schema } = mongoose;

const MESSAGE_TYPES = ["text", "image", "document", "audio", "video", "unknown"];
const SENDER_TYPES = ["customer", "internal"];

const WhatsAppMessageSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "WhatsAppConversation", required: true, index: true },

    metaMessageId: { type: String, default: "", index: true }, // WhatsApp message id (dedupe inbound)
    phoneNumber: { type: String, default: "" },

    senderType: { type: String, enum: SENDER_TYPES, required: true },
    messageType: { type: String, enum: MESSAGE_TYPES, default: "text" },
    messageText: { type: String, default: "" },
    mediaUrl: { type: String, default: "" },
    rawPayload: { type: Schema.Types.Mixed, default: null },

    status: { type: String, default: "received" }, // received | sent | delivered | read | failed
    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null }, // internal user who replied
    isInternalNote: { type: Boolean, default: false }, // private team note shown only to internal users
  },
  { timestamps: true }
);

WhatsAppMessageSchema.index({ organization: 1, conversationId: 1, createdAt: 1 });

module.exports = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);
module.exports.WA_MESSAGE_TYPES = MESSAGE_TYPES;
