// Creates (or resets) a read-only Auditor test account in the owner's organization.
// Run:  node scripts/seed-auditor.js
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const User = require("../models/User");

const EMAIL = process.env.SEED_AUDITOR_EMAIL || "auditor@codex-fze.com";
const PASSWORD = process.env.SEED_AUDITOR_PASSWORD || "Audit@2026";
const NAME = "External Auditor";

(async () => {
  await connectDB();
  await new Promise((r) => setTimeout(r, 1200));
  const owner = await User.findOne({ role: "owner_admin" }).select("organization");
  if (!owner?.organization) { console.log("No owner_admin/organization found."); process.exit(1); }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let u = await User.findOne({ email: EMAIL.toLowerCase() }).select("+passwordHash");
  if (u) {
    u.name = NAME; u.role = "auditor"; u.userType = "internal"; u.status = "active";
    u.organization = owner.organization; u.passwordHash = passwordHash; u.mustSetPassword = false;
    await u.save();
    console.log("Updated existing auditor user.");
  } else {
    u = await User.create({ name: NAME, email: EMAIL.toLowerCase(), role: "auditor", userType: "internal", status: "active", organization: owner.organization, passwordHash, mustSetPassword: false });
    console.log("Created auditor user.");
  }
  console.log("\n  Email:    ", EMAIL);
  console.log("  Password: ", PASSWORD);
  console.log("  Role:      auditor (read-only)\n");
  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
