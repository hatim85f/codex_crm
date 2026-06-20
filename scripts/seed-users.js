require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const User = require("../models/User");
const Organization = require("../models/Organization");

// Internal team members for testing. Idempotent: matched by email, so re-running
// updates name/phone/role/avatar without creating duplicates.
const TEAM = [
  { name: "Hatim Codex", email: "hatim@codex-fze.com", phone: "+971 50 000 0001", role: "owner_admin" },
  { name: "Operations Admin", email: "admin@codex-fze.com", phone: "+971 50 000 0002", role: "admin" },
  { name: "Chahrazad Assous", email: "chahrazad.a@codex-fze.com", phone: "+971 55 846 9049", role: "sales" },
  { name: "Sales Executive", email: "sales@codex-fze.com", phone: "+971 50 000 0003", role: "sales" },
  { name: "Marketing Lead", email: "marketing@codex-fze.com", phone: "+971 50 000 0004", role: "marketing" },
  { name: "Project Leader", email: "project.leader@codex-fze.com", phone: "+971 50 000 0005", role: "team_leader" },
  { name: "Frontend Developer", email: "frontend@codex-fze.com", phone: "+971 50 000 0006", role: "developer" },
  { name: "Backend Developer", email: "backend@codex-fze.com", phone: "+971 50 000 0007", role: "developer" },
  { name: "UI UX Designer", email: "designer@codex-fze.com", phone: "+971 50 000 0008", role: "designer" },
  { name: "Content Creator", email: "content@codex-fze.com", phone: "+971 50 000 0009", role: "content_creator" },
  { name: "Accountant", email: "accounts@codex-fze.com", phone: "+971 50 000 0010", role: "accountant" },
  { name: "Support Agent", email: "support@codex-fze.com", phone: "+971 50 000 0011", role: "support" },
];

// Brand palette — avatars are generated (ui-avatars) so no upload is needed; only the URL is stored.
const PALETTE = ["0D6666", "6366F1", "E0531F", "7C3AED", "0EA5A0", "D4537E", "0A7E76", "1D4ED8", "B45309", "15803D", "BE3E72", "1A2B3B"];

const avatarFor = (name, i) => {
  const seed = encodeURIComponent(name).replace(/%20/g, "+");
  const bg = PALETTE[i % PALETTE.length];
  return `https://ui-avatars.com/api/?name=${seed}&background=${bg}&color=ffffff&bold=true&size=256&format=png`;
};

const run = async () => {
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!password) {
    console.error("Set SEED_OWNER_PASSWORD in .env before seeding (all test users share it).");
    process.exit(1);
  }
  await connectDB();

  const org = (await Organization.findOne({ name: "Codex FZE Technology" })) || (await Organization.findOne({}));
  if (!org) {
    console.error("No organization found. Run scripts/seed-owner.js first.");
    process.exit(1);
  }
  console.log(`Using organization: ${org.name} (${org._id})`);

  const passwordHash = await bcrypt.hash(password, 10);
  let created = 0;
  let updated = 0;

  for (let i = 0; i < TEAM.length; i += 1) {
    const t = TEAM[i];
    const avatar = avatarFor(t.name, i);
    const email = t.email.toLowerCase().trim();
    let user = await User.findOne({ email }).select("+passwordHash");
    if (user) {
      user.name = t.name;
      user.phone = t.phone;
      user.role = t.role;
      user.organization = org._id;
      user.userType = "internal";
      user.status = "active";
      user.avatar = avatar;
      if (!user.passwordHash) user.passwordHash = passwordHash; // keep existing real passwords
      await user.save();
      updated += 1;
      console.log(`Updated: ${t.name} <${email}> [${t.role}]`);
    } else {
      await User.create({
        name: t.name,
        email,
        phone: t.phone,
        role: t.role,
        organization: org._id,
        userType: "internal",
        status: "active",
        avatar,
        passwordHash,
      });
      created += 1;
      console.log(`Created: ${t.name} <${email}> [${t.role}]`);
    }
  }

  console.log(`\nDone. Created ${created}, updated ${updated}. All test users share the SEED_OWNER_PASSWORD.`);
  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Seed failed:", err.message);
  try { await mongoose.connection.close(); } catch (e) {}
  process.exit(1);
});
