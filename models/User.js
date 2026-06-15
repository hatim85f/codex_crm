const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

const ROLES = ["owner_admin", "admin", "sales", "marketing", "team_leader"];

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, default: "" },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    userType: { type: String, default: "internal" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    avatar: { type: String, default: "" },
    generalTeams: [{ type: Schema.Types.ObjectId, ref: "Team" }],
  },
  { timestamps: true }
);

UserSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

UserSchema.statics.ROLES = ROLES;

module.exports = mongoose.model("User", UserSchema);
