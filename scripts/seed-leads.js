// Seed sample Leads & Intake data so the screens have something to click through.
// Usage:
//   node scripts/seed-leads.js          -> (re)seed sample data
//   node scripts/seed-leads.js --clean  -> remove all sample data
//
// All sample records are tagged so cleanup is exact:
//   - phone numbers start with +99900
//   - MetaLeadReport.metaLeadId starts with "SAMPLE_"
require("dotenv").config();
const mongoose = require("mongoose");

const PHONE_PREFIX = "+99900";
const META_PREFIX = "SAMPLE_";

(async () => {
  await mongoose.connect(process.env.mongoURI || process.env.MONGO_URI);
  const User = require("../models/User");
  const PotentialCustomer = require("../models/PotentialCustomer");
  const WhatsAppConversation = require("../models/WhatsAppConversation");
  const WhatsAppMessage = require("../models/WhatsAppMessage");
  const MetaLeadReport = require("../models/MetaLeadReport");

  const owner = await User.findOne({ role: "owner_admin", userType: "internal" }).select("_id organization");
  if (!owner) { console.error("No owner_admin found — seed the owner first."); process.exit(1); }
  const org = owner.organization;

  // ---- cleanup helper (used by --clean and before re-seeding) ----
  async function clean() {
    const convs = await WhatsAppConversation.find({ phoneNumber: new RegExp("^\\" + PHONE_PREFIX) }).select("_id");
    const convIds = convs.map((c) => c._id);
    const r = {
      waMsgs: (await WhatsAppMessage.deleteMany({ conversationId: { $in: convIds } })).deletedCount,
      waConvs: (await WhatsAppConversation.deleteMany({ phoneNumber: new RegExp("^\\" + PHONE_PREFIX) })).deletedCount,
      potentials: (await PotentialCustomer.deleteMany({ $or: [{ phone: new RegExp("^\\" + PHONE_PREFIX) }, { whatsapp: new RegExp("^\\" + PHONE_PREFIX) }] })).deletedCount,
      metaLeads: (await MetaLeadReport.deleteMany({ metaLeadId: new RegExp("^" + META_PREFIX) })).deletedCount,
    };
    return r;
  }

  if (process.argv.includes("--clean")) {
    console.log("Cleaned sample leads:", await clean());
    await mongoose.disconnect();
    return;
  }

  // Re-seed cleanly (idempotent).
  await clean();

  const now = Date.now();
  const day = 86400000;

  const potentials = await PotentialCustomer.insertMany([
    { organization: org, name: "Aisha Khan", companyName: "Khan Trading", phone: PHONE_PREFIX + "1001", whatsapp: PHONE_PREFIX + "1001", email: "aisha@khantrading.ae", source: "whatsapp", interestedService: "Social media management", status: "need_reply", priority: "high", assignedTo: owner._id, firstMessage: "Hi, saw your ad — can you manage our Instagram?", lastMessageAt: new Date(now - 2 * 3600e3), nextFollowUpDate: new Date(now + 1 * day), notes: "Hot lead from WhatsApp.", createdBy: owner._id },
    { organization: org, name: "David Lee", companyName: "Lee Logistics", phone: PHONE_PREFIX + "1002", email: "david@leelogistics.com", source: "website", interestedService: "Website redesign", status: "qualified", priority: "medium", assignedTo: owner._id, nextFollowUpDate: new Date(now + 3 * day), notes: "Submitted website contact form.", createdBy: owner._id },
    { organization: org, name: "Sara Ahmed", companyName: "", phone: PHONE_PREFIX + "1003", source: "meta_ads", interestedService: "Lead generation", status: "contacted", priority: "urgent", notes: "Came from Summer 2026 campaign.", createdBy: owner._id },
    { organization: org, name: "Omar Farooq", companyName: "Farooq & Co", phone: PHONE_PREFIX + "1004", email: "omar@farooq.co", source: "referral", interestedService: "Branding package", status: "quotation_sent", priority: "medium", notes: "Referred by an existing client.", createdBy: owner._id },
    { organization: org, name: "Lina Said", companyName: "", phone: PHONE_PREFIX + "1005", source: "manual", interestedService: "Photography", status: "follow_up_later", priority: "low", nextFollowUpDate: new Date(now + 14 * day), notes: "Asked us to follow up next month.", createdBy: owner._id },
  ]);
  const aisha = potentials[0];

  // WhatsApp: one thread linked to Aisha, one from an unknown number (+ its auto-PC).
  const conv1 = await WhatsAppConversation.create({ organization: org, phoneNumber: PHONE_PREFIX + "1001", customerName: "Aisha Khan", potentialCustomerId: aisha._id, assignedTo: owner._id, status: "pending", lastMessageAt: new Date(now - 2 * 3600e3), lastMessagePreview: "Perfect, please send the package details", unreadCount: 1 });
  await WhatsAppMessage.insertMany([
    { organization: org, conversationId: conv1._id, phoneNumber: conv1.phoneNumber, senderType: "customer", messageType: "text", messageText: "Hi, saw your ad — can you manage our Instagram?", status: "received", createdAt: new Date(now - 3 * 3600e3) },
    { organization: org, conversationId: conv1._id, phoneNumber: conv1.phoneNumber, senderType: "internal", messageType: "text", messageText: "Hello Aisha! Absolutely — we offer monthly social packages.", status: "sent", sentBy: owner._id, createdAt: new Date(now - 2.5 * 3600e3) },
    { organization: org, conversationId: conv1._id, phoneNumber: conv1.phoneNumber, senderType: "customer", messageType: "text", messageText: "Perfect, please send the package details", status: "received", createdAt: new Date(now - 2 * 3600e3) },
  ]);

  const unknownPc = await PotentialCustomer.create({ organization: org, name: "Unknown (+99900 2002)", whatsapp: PHONE_PREFIX + "2002", phone: PHONE_PREFIX + "2002", source: "whatsapp", status: "new_inquiry", priority: "medium", firstMessage: "Do you do video editing?", lastMessageAt: new Date(now - 30 * 60e3) });
  const conv2 = await WhatsAppConversation.create({ organization: org, phoneNumber: PHONE_PREFIX + "2002", customerName: "", potentialCustomerId: unknownPc._id, status: "open", lastMessageAt: new Date(now - 30 * 60e3), lastMessagePreview: "Do you do video editing?", unreadCount: 1 });
  await WhatsAppMessage.create({ organization: org, conversationId: conv2._id, phoneNumber: conv2.phoneNumber, senderType: "customer", messageType: "text", messageText: "Do you do video editing?", status: "received", createdAt: new Date(now - 30 * 60e3) });

  // Meta lead reports across two campaigns/forms, incl. one duplicate.
  const base = (i, over) => ({ organization: org, metaLeadId: META_PREFIX + i, pageId: "PAGE_DEMO", status: "new", rawPayload: { sample: true }, ...over });
  const ml1 = await MetaLeadReport.create(base(1, { formId: "FORM_A", campaignName: "Summer 2026", campaignId: "C_SUM", adName: "IG Reel A", fullName: "John Buyer", phone: PHONE_PREFIX + "3001", email: "john@buy.com", submittedAt: new Date(now - 5 * day), fieldData: [{ name: "full_name", label: "Full name", value: "John Buyer" }, { name: "budget", label: "Budget", value: "$5k-$10k" }] }));
  await MetaLeadReport.create(base(2, { formId: "FORM_A", campaignName: "Summer 2026", campaignId: "C_SUM", adName: "IG Reel A", fullName: "Mary Quinn", phone: PHONE_PREFIX + "3002", email: "mary@quinn.com", submittedAt: new Date(now - 4 * day), status: "contacted", fieldData: [{ name: "full_name", label: "Full name", value: "Mary Quinn" }] }));
  await MetaLeadReport.create(base(3, { formId: "FORM_B", campaignName: "Ramadan Promo", campaignId: "C_RAM", adName: "FB Carousel", fullName: "Ali Raza", phone: PHONE_PREFIX + "3003", submittedAt: new Date(now - 2 * day), status: "qualified", fieldData: [{ name: "full_name", label: "Full name", value: "Ali Raza" }] }));
  await MetaLeadReport.create(base(4, { formId: "FORM_A", campaignName: "Summer 2026", campaignId: "C_SUM", adName: "IG Reel A", fullName: "John Buyer", phone: PHONE_PREFIX + "3001", email: "john@buy.com", submittedAt: new Date(now - 1 * day), status: "duplicate", isDuplicate: true, duplicateOf: ml1._id, fieldData: [{ name: "full_name", label: "Full name", value: "John Buyer" }] }));

  console.log("Seeded sample leads under org", String(org), {
    potentialCustomers: potentials.length + 1,
    whatsappConversations: 2,
    metaLeadReports: 4,
  });
  await mongoose.disconnect();
})().catch((e) => { console.error("seed-leads error:", e.message); process.exit(1); });
