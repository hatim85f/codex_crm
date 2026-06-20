require("dotenv").config();

const mongoose = require("mongoose");
const connectDB = require("../config/db");
const QuotationTerm = require("../models/QuotationTerm");
const Organization = require("../models/Organization");

// Default reusable quotation terms. isDefault:true means they auto-load into new quotations.
const TERMS = [
  { title: "Quotation Validity", category: "validity", body: "This quotation is valid for 7 calendar days from the issue date. After this period, the quotation will expire automatically and pricing may be subject to change based on the service scope, supplier costs, domain/hosting pricing, third-party tools, exchange rates, and the pricing available at the time of creating a new quotation." },
  { title: "Scope of Work", category: "general", body: "The quotation covers only the services, features, pages, integrations, deliverables, and quantities clearly mentioned in the quotation line items. Any additional requirement, feature, page, integration, change in scope, or extra work requested by the client will be quoted separately." },
  { title: "Design Approval and Revisions", category: "design", body: "After the client approves the design direction, layout, UI/UX, branding style, or visual concept, the client will be entitled to a maximum of 3 revision rounds. Any additional revision rounds, major design changes, or changes after approval may be charged separately based on the required work." },
  { title: "Content Responsibility", category: "general", body: "Unless content creation is specifically included in the quotation, the client is responsible for providing all required text, images, videos, product details, service descriptions, company information, legal content, policies, and any other content needed to complete the project." },
  { title: "Domain Name", category: "domain", body: "If Codex Technology provides or purchases a domain name on behalf of the client, the domain remains subject to the domain registrar's availability, pricing, renewal terms, and renewal dates. Domain renewal, renewal timing, and renewal payment are the client's responsibility. Renewal pricing may change and will be based on the pricing available at the time of renewal." },
  { title: "Hosting, Email, and Third-Party Services", category: "hosting", body: "Hosting, business email, plugins, themes, Shopify apps, APIs, payment gateways, automation tools, AI tools, booking tools, CRM tools, or any third-party service may have separate subscription, renewal, usage, or transaction fees. These fees are the client's responsibility unless clearly included in the quotation." },
  { title: "Payment Terms", category: "payment", body: "Project work will start after receiving the agreed advance payment, unless otherwise agreed in writing. Remaining payments must be completed according to the payment schedule mentioned in the quotation or invoice. Delays in payment may delay project delivery." },
  { title: "Delivery Timeline", category: "general", body: "Delivery timelines are estimated based on the agreed scope and the client's timely feedback, approvals, content submission, access sharing, and payment completion. Any delay from the client side may extend the delivery timeline." },
  { title: "Client Access and Approvals", category: "general", body: "The client is responsible for providing required access, login credentials, approvals, files, content, brand assets, and feedback on time. Codex Technology will not be responsible for delays caused by missing access, delayed feedback, or incomplete information." },
  { title: "Final Delivery and Handover", category: "general", body: "Final delivery will be considered completed once the agreed deliverables are submitted, published, transferred, or made available to the client according to the approved scope. Any new request after final delivery may be treated as a new task or maintenance request." },
  { title: "Service-Specific Terms", category: "custom", body: "Some services may require additional terms depending on the type of work, such as website development, Shopify setup, mobile apps, digital marketing, SEO, hosting, email setup, domain management, AI automation, or maintenance. These service-specific terms can be added, edited, or removed before saving the quotation." },
];

const run = async () => {
  await connectDB();
  const org = (await Organization.findOne({ name: "Codex FZE Technology" })) || (await Organization.findOne({}));
  if (!org) { console.error("No organization found. Run scripts/seed-owner.js first."); process.exit(1); }
  console.log(`Using organization: ${org.name} (${org._id})`);

  let created = 0;
  let skipped = 0;
  for (let i = 0; i < TERMS.length; i += 1) {
    const t = TERMS[i];
    const exists = await QuotationTerm.findOne({ organization: org._id, title: t.title });
    if (exists) { skipped += 1; console.log(`Exists: ${t.title}`); continue; }
    await QuotationTerm.create({
      organization: org._id,
      title: t.title,
      body: t.body,
      category: t.category,
      isDefault: true,
      isActive: true,
      sortOrder: i + 1,
    });
    created += 1;
    console.log(`Created: ${t.title} [${t.category}]`);
  }

  console.log(`\nDone. Created ${created}, skipped ${skipped}.`);
  await mongoose.connection.close();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("Seed failed:", err.message);
  try { await mongoose.connection.close(); } catch (e) {}
  process.exit(1);
});
