const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const WhatsAppSchema = new Schema(
  {
    wabaId: { type: String, trim: true }, // WhatsApp Business Account ID
    phoneNumberId: { type: String, trim: true }, // WhatsApp Phone Number ID
    apiType: { type: String, enum: ["cloud", "onprem"], default: "cloud" },
    status: { type: String, enum: ["inactive", "active"], default: "inactive" },
  },
  { _id: false }
);

const LeadIntegrationsSchema = new Schema(
  {
    metaBusinessId: { type: String, trim: true }, // Business Manager ID
    metaAdAccountId: { type: String, trim: true }, // act_XXXXXXXX
    metaPageId: { type: String, trim: true }, // Page ID
    whatsapp: WhatsAppSchema,
  },
  { _id: false }
);

// Keep secrets separate (encrypted strings). Select=false so they don’t return by default.
const SecretsSchema = new Schema(
  {
    metaAccessTokenEnc: { type: String, select: false },
    wabaTokenEnc: { type: String, select: false },
    webhookVerifyTokenEnc: { type: String, select: false },
  },
  { _id: false }
);

const OrganizationSchema = new Schema(
  {
    organizationName: { type: String, required: true, trim: true },

    // Slug for subdomain/routing (e.g., "codex")
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [
        /^[a-z0-9-]+$/,
        "Slug can contain lowercase letters, numbers, and hyphens only",
      ],
    },

    address: { type: String, trim: true },
    phoneNumber: { type: String, trim: true }, // Consider normalizing to E.164
    website: { type: String, trim: true },
    logo: { type: String, trim: true },
    industry: { type: String, trim: true },

    // Public/social links (not API IDs)
    social: {
      facebook: { type: String, trim: true },
      instagram: { type: String, trim: true },
      whatsapp: { type: String, trim: true }, // public phone (not phoneNumberId)
    },

    // Will be set after creating the admin user (optional for now)
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },

    // Public identifiers for integrations (safe to store in plaintext)
    leadIntegrations: LeadIntegrationsSchema,

    // Encrypted tokens (optional; add when connected)
    secrets: SecretsSchema,

    // Commercialization + preferences
    plan: {
      type: String,
      enum: ["starter", "growth", "pro"],
      default: "starter",
    },
    settings: Schema.Types.Mixed,
  },
  { timestamps: true }
);

// Helpful indexes
OrganizationSchema.index({ slug: 1 }, { unique: true });
OrganizationSchema.index({ "leadIntegrations.metaAdAccountId": 1 });
OrganizationSchema.index({ "leadIntegrations.whatsapp.wabaId": 1 });
OrganizationSchema.index({ "leadIntegrations.whatsapp.phoneNumberId": 1 });

// Ensure slug hygiene if provided in odd casing/spaces
OrganizationSchema.pre("save", function (next) {
  if (this.isModified("slug") && typeof this.slug === "string") {
    this.slug = this.slug.toLowerCase().trim();
  }
  next();
});

module.exports = Organization = mongoose.model(
  "organization",
  OrganizationSchema
);
