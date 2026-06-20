require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const User = require("../models/User");
const Team = require("../models/Team");
const Organization = require("../models/Organization");

const ORG = {
  name: "Codex FZE Technology",
  logo: "", // set via the app (Cloudinary) or here as a secure_url
  status: "active",
};

// Credentials come from .env (gitignored) — never hard-code secrets in source.
const OWNER = {
  name: process.env.SEED_OWNER_NAME || "Hatim Fayez",
  email: process.env.SEED_OWNER_EMAIL || "owner@example.com",
  phone: "",
  role: "owner_admin",
  userType: "internal",
  status: "active",
  password: process.env.SEED_OWNER_PASSWORD,
};

const DEFAULT_TEAMS = [
  { name: "Marketing", department: "Marketing" },
  { name: "Sales", department: "Sales" },
  { name: "Operations", department: "Operations" },
];

const run = async () => {
  if (!OWNER.password) {
    console.error("Set SEED_OWNER_PASSWORD (and SEED_OWNER_EMAIL) in .env before seeding.");
    process.exit(1);
  }
  await connectDB();

  // 1) The single Codex company record
  let org = await Organization.findOne({ name: ORG.name });
  if (!org) {
    org = await Organization.create(ORG);
    console.log(`Created organization: ${org.name} (${org._id})`);
  } else {
    console.log(`Organization exists: ${org.name} (${org._id})`);
  }

  // 2) Owner (idempotent) linked to the org
  const passwordHash = await bcrypt.hash(OWNER.password, 10);
  let owner = await User.findOne({ email: OWNER.email }).select("+passwordHash");
  if (owner) {
    owner.name = OWNER.name;
    owner.organization = org._id;
    owner.role = OWNER.role;
    owner.userType = OWNER.userType;
    owner.status = OWNER.status;
    owner.passwordHash = passwordHash;
    await owner.save();
    console.log(`Updated owner: ${owner.email} (${owner._id})`);
  } else {
    owner = await User.create({
      name: OWNER.name,
      organization: org._id,
      email: OWNER.email,
      phone: OWNER.phone,
      role: OWNER.role,
      userType: OWNER.userType,
      status: OWNER.status,
      passwordHash,
    });
    console.log(`Created owner: ${owner.email} (${owner._id})`);
  }

  // 3) Default general teams (scoped to the org)
  for (const t of DEFAULT_TEAMS) {
    const existing = await Team.findOne({ name: t.name, organization: org._id });
    if (existing) {
      console.log(`Team exists: ${t.name}`);
    } else {
      const team = await Team.create({
        name: t.name,
        organization: org._id,
        type: "general",
        department: t.department,
        status: "active",
        members: [],
      });
      console.log(`Created team: ${team.name} (${team._id})`);
    }
  }

  await mongoose.connection.close();
  console.log("Seed complete.");
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Seed failed:", err);
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(1);
});
