const Clients = require("../models/Clients");
const normalizeToE164 = require("./normalizeToE164");
const bcrypt = require("bcryptjs");

const pickName = (fullName) => {
  const n = String(fullName || "").trim();
  if (!n) return { firstName: "WhatsApp", lastName: "Lead" };
  const parts = n.split(" ");
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || "Lead" };
};

const makeWaEmail = (waId, orgId) => {
  // ensures uniqueness even if you still have global unique on email
  return `${waId}.${String(orgId).slice(-6)}@wa.local`.toLowerCase();
};

const createOrGetClientFromWhatsApp = async ({
  orgId,
  handledBy,
  value,
  countryCode = "AE",
}) => {
  if (!orgId) throw new Error("orgId is required");
  if (!value?.messages?.[0]) throw new Error("No messages in webhook payload");

  const msg = value.messages[0];

  const waFrom = msg.from;
  if (!waFrom) throw new Error("Missing msg.from");

  const waE164 = waFrom.startsWith("+")
    ? normalizeToE164(waFrom, countryCode)
    : normalizeToE164(`+${waFrom}`, countryCode);

  if (!waE164) throw new Error("Invalid WhatsApp number after normalize");

  const waId = waE164.replace("+", "");

  const profileName = value?.contacts?.[0]?.profile?.name;
  const { firstName, lastName } = pickName(profileName);

  // 1) Find existing client under same org
  let client = await Clients.findOne({
    clientFor: orgId,
    $or: [{ waId }, { whatsAppE164: waE164 }, { phoneE164: waE164 }],
  });

  if (client) return { client, isNew: false };

  // 2) Create new client (schema requires password + source + email)
  const rawPass = `${waId}@1234`;
  const hashedPassword = await bcrypt.hash(rawPass, 10);

  client = new Clients({
    firstName,
    lastName,
    email: makeWaEmail(waId, orgId),
    phone: waE164,
    phoneE164: waE164,
    whatsAppNumber: waE164,
    whatsAppE164: waE164,
    waId,
    country: countryCode,
    password: hashedPassword,
    source: "whatsapp", // ✅ must match enum
    handledBy,
    createdBy: handledBy, // optional but useful
    clientFor: orgId,
  });

  await client.save();

  return { client, isNew: true };
};

module.exports = createOrGetClientFromWhatsApp;
