const mongoose = require("mongoose");

const { Schema } = mongoose;

const MemberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    roleInTeam: { type: String, default: "member" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TeamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, default: "general" },
    department: { type: String, default: "" },
    description: { type: String, default: "" },
    teamLeaderId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    members: { type: [MemberSchema], default: [] },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Team", TeamSchema);
