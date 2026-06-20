const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema } = mongoose;

const ROLES = [
  "owner_admin", "admin", "sales", "marketing", "team_leader",
  "developer", "designer", "content_creator", "accountant", "support",
  "customer",
];
const USER_TYPES = ["internal", "customer"];
const STATUSES = ["active", "inactive", "invited"];

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, default: "" },
    // Not required: invited customers set their password later via activation.
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true },
    userType: { type: String, enum: USER_TYPES, default: "internal" },
    status: { type: String, enum: STATUSES, default: "active" },
    avatar: { type: String, default: "" }, // Cloudinary secure_url
    jobTitle: { type: String, default: "" },
    department: { type: String, default: "" },
    generalTeams: [{ type: Schema.Types.ObjectId, ref: "Team" }],

    // Customer portal linkage
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", index: true },
    customerContactId: { type: Schema.Types.ObjectId, ref: "CustomerContact" },

    // Activation (no expiry — token valid until used / disabled / replaced)
    mustSetPassword: { type: Boolean, default: false },
    activationTokenHash: { type: String, select: false },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserSchema.methods.comparePassword = function (plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

UserSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.activationTokenHash;
    return ret;
  },
});

UserSchema.statics.ROLES = ROLES;
UserSchema.statics.USER_TYPES = USER_TYPES;

module.exports = mongoose.model("User", UserSchema);
