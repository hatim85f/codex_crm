require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const connectDB = require("../config/db");
const User = require("../models/User");
const Team = require("../models/Team");

const OWNER = {
  name: "Hatim Fayez",
  email: "hatim.fayez@codex-fze.com",
  phone: "",
  role: "owner_admin",
  userType: "internal",
  status: "active",
  password: "hatim@123$",
};

const DEFAULT_TEAMS = [
  { name: "Marketing", department: "Marketing" },
  { name: "Sales", department: "Sales" },
  { name: "Operations", department: "Operations" },
];

const run = async () => {
  await connectDB();

  // Owner (idempotent upsert)
  const passwordHash = await bcrypt.hash(OWNER.password, 10);
  let owner = await User.findOne({ email: OWNER.email }).select("+passwordHash");
  if (owner) {
    owner.name = OWNER.name;
    owner.role = OWNER.role;
    owner.userType = OWNER.userType;
    owner.status = OWNER.status;
    owner.passwordHash = passwordHash;
    await owner.save();
    console.log(`Updated owner: ${owner.email} (${owner._id})`);
  } else {
    owner = await User.create({
      name: OWNER.name,
      email: OWNER.email,
      phone: OWNER.phone,
      role: OWNER.role,
      userType: OWNER.userType,
      status: OWNER.status,
      passwordHash,
    });
    console.log(`Created owner: ${owner.email} (${owner._id})`);
  }

  // Default general teams (idempotent)
  for (const t of DEFAULT_TEAMS) {
    const existing = await Team.findOne({ name: t.name });
    if (existing) {
      console.log(`Team exists: ${t.name}`);
    } else {
      const team = await Team.create({
        name: t.name,
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
