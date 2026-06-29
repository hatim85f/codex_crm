// Grant ACTIVE customer-portal access to an existing CustomerContact with a known
// password (skips the email activation flow, so you can hand over credentials).
// Run:  node scripts/grant-portal-access.js <contactEmail> [password]
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const User = require("../models/User");
const Customer = require("../models/Customer");
const CustomerContact = require("../models/CustomerContact");

const EMAIL = (process.argv[2] || "").toLowerCase();
const PASSWORD = process.argv[3] || "Portal@2026";

(async () => {
  if (!EMAIL) { console.log("Usage: node scripts/grant-portal-access.js <contactEmail> [password]"); process.exit(1); }
  await connectDB();
  await new Promise((r) => setTimeout(r, 1200));

  const contact = await CustomerContact.findOne({ email: new RegExp(`^${EMAIL}$`, "i") });
  if (!contact) { console.log(`No customer contact found with email ${EMAIL}`); process.exit(1); }
  const customer = await Customer.findById(contact.customerId);
  if (!customer) { console.log("Customer record not found for that contact."); process.exit(1); }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let user = contact.userId ? await User.findById(contact.userId) : await User.findOne({ email: contact.email.toLowerCase() });
  if (user && user.userType !== "customer") { console.log("That email already belongs to an INTERNAL user — aborting."); process.exit(1); }
  if (!user) user = new User({ name: contact.name, email: contact.email.toLowerCase() });

  user.name = contact.name;
  user.organization = customer.organization;
  user.role = "customer";
  user.userType = "customer";
  user.customerId = customer._id;
  user.customerContactId = contact._id;
  user.status = "active";
  user.mustSetPassword = false;
  user.activationTokenHash = undefined;
  user.passwordHash = passwordHash;
  await user.save();

  contact.userId = user._id;
  contact.portalStatus = "active";
  await contact.save();

  console.log("\n  Portal access granted ✅");
  console.log("  Customer:  ", customer.displayName);
  console.log("  Contact:   ", contact.name);
  console.log("  Email:     ", user.email);
  console.log("  Password:  ", PASSWORD);
  console.log("  Status:     active (customer portal)\n");
  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  if (e.cause) console.error("CAUSE:", e.cause);
  if (e.errors) console.error("VALIDATION:", Object.keys(e.errors).map((k) => `${k}: ${e.errors[k].message}`).join("; "));
  process.exit(1);
});
