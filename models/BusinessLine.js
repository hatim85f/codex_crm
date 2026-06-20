const mongoose = require("mongoose");

const { Schema } = mongoose;

const BusinessLineSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

BusinessLineSchema.index({ organization: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("BusinessLine", BusinessLineSchema);
