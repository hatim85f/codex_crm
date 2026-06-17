const mongoose = require("mongoose");

const { Schema } = mongoose;

const CustomerContactSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", index: true, required: true },

    name: { type: String, required: true, trim: true },
    title: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    isPrimary: { type: Boolean, default: false },

    // Portal access
    portalStatus: { type: String, enum: ["none", "invited", "active"], default: "none" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CustomerContact", CustomerContactSchema);
