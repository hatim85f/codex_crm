require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Organization = require("../models/Organization");
const User = require("../models/User");
const BusinessLine = require("../models/BusinessLine");
const ServiceCategory = require("../models/ServiceCategory");
const Service = require("../models/Service");

const businessLines = [
  "Software Development",
  "Marketing Services",
  "Media Production",
  "eCommerce",
  "Dropshipping",
  "Hosting / Maintenance",
  "Other",
];

const categories = [
  "Software Development",
  "Marketing Services",
  "Media Production",
  "eCommerce",
  "Dropshipping",
  "Hosting / Maintenance",
  "Other",
];

const services = [
  ["WordPress Website", "Software Development", "Custom responsive CMS-based corporate website.", 15000, "one_time", "project"],
  ["Shopify Store Setup", "eCommerce", "Store setup, theme configuration, payment/shipping basics.", 12000, "one_time", "store"],
  ["Mobile App Development", "Software Development", "iOS and Android app design and development package.", 45000, "one_time", "project"],
  ["CRM Development", "Software Development", "Custom CRM modules, workflows, and dashboards.", 35000, "one_time", "project"],
  ["AI Automation", "Software Development", "AI workflow automation and internal tool integration.", 18000, "one_time", "package"],
  ["Social Media Management", "Marketing Services", "Monthly content calendar, posting, and account management.", 3500, "monthly", "month"],
  ["Content Creation", "Marketing Services", "Reusable content package for social and website channels.", 2500, "monthly", "package"],
  ["Paid Ads Management", "Marketing Services", "Google, Meta, or LinkedIn campaign management.", 3000, "monthly", "campaign"],
  ["SEO Monthly Package", "Marketing Services", "Technical SEO, content recommendations, and reporting.", 4000, "monthly", "month"],
  ["Video Shooting", "Media Production", "On-site video shooting session.", 3500, "one_time", "video"],
  ["Video Editing", "Media Production", "Editing, color correction, and export for one video.", 1200, "one_time", "video"],
  ["Product Photography", "Media Production", "Product photo session and edited image delivery.", 1800, "one_time", "package"],
  ["Website Maintenance", "Hosting / Maintenance", "Monthly website updates, backups, and checks.", 1500, "monthly", "month"],
  ["Hosting Setup", "Hosting / Maintenance", "Hosting environment setup and DNS configuration.", 1200, "one_time", "setup"],
  ["Email Setup", "Hosting / Maintenance", "Business mailbox and DNS record setup.", 750, "one_time", "setup"],
];

async function main() {
  await connectDB();
  const org = await Organization.findOne().sort({ createdAt: 1 });
  if (!org) throw new Error("No organization found. Seed an owner/organization first.");
  const owner = await User.findOne({ organization: org._id, role: { $in: ["owner_admin", "admin"] } }).sort({ createdAt: 1 });
  const byName = new Map();

  for (const name of businessLines) {
    await BusinessLine.findOneAndUpdate(
      { organization: org._id, name },
      {
        $setOnInsert: { organization: org._id, name, description: `${name} business line`, createdBy: owner?._id || null },
        $set: { updatedBy: owner?._id || null },
      },
      { upsert: true, new: true }
    );
  }

  for (const name of categories) {
    const category = await ServiceCategory.findOneAndUpdate(
      { organization: org._id, name },
      {
        $setOnInsert: { organization: org._id, name, businessLine: name, description: `${name} service catalog category`, createdBy: owner?._id || null },
        $set: { updatedBy: owner?._id || null },
      },
      { upsert: true, new: true }
    );
    byName.set(name, category);
  }

  for (const [serviceName, businessLine, description, defaultPrice, billingType, unitLabel] of services) {
    const category = byName.get(businessLine) || byName.get("Other");
    await Service.findOneAndUpdate(
      { organization: org._id, serviceName },
      {
        $setOnInsert: {
          organization: org._id,
          serviceName,
          categoryId: category._id,
          businessLine,
          description,
          defaultPrice,
          currency: "AED",
          billingType,
          defaultQuantity: 1,
          unitLabel,
          taxable: true,
          taxRate: 5,
          status: "active",
          notes: "Seeded default service",
          createdBy: owner?._id || null,
        },
        $set: { updatedBy: owner?._id || null },
      },
      { upsert: true, new: true }
    );
  }

  console.log(`Seeded ${businessLines.length} business lines, ${categories.length} categories and ${services.length} services`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
