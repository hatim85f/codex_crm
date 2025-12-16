const express = require("express");
const router = express.Router();
const { check, validationResult } = require("express-validator");
const Clients = require("../../models/Clients");
const bcrypt = require("bcryptjs");

const auth = require("../../middleware/auth");

const normalizeToE164 = require("../../helpers/normalizeToE164");
const extractWhatsAppIdentity = require("../../helpers/extractWhatsAppIdentity");

router.get("/", auth, async (req, res) => {
  return res.status(200).json({ message: "Clients route works" });
});

router.post("/add-client", auth, async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    whatsAppNumber,
    country,
    countryCode, // ISO-2 like "AE"
    companyName,
    companyLogo,
    profilePicture,
    source,
    organizationId,
  } = req.body;

  try {
    const isClientExists = await Clients.findOne({ email });
    if (isClientExists) {
      return res
        .status(409)
        .json({ error: "Client with this email already exists" });
    }

    const phoneE164 = normalizeToE164(phone, countryCode);
    const whatsAppE164 = normalizeToE164(whatsAppNumber, countryCode);

    if (!phoneE164 || !whatsAppE164) {
      return res.status(400).json({ error: "Invalid phone/WhatsApp number" });
    }

    const waId = whatsAppE164.replace("+", "");

    const clean = (s) =>
      String(s || "")
        .trim()
        .replace(/\s+/g, "");
    const userPassword = `${clean(firstName)}.${clean(lastName)}@1234`;

    const hashedPassword = await bcrypt.hash(userPassword, 10);

    const newClient = new Clients({
      firstName,
      lastName,
      email,
      phone,
      phoneE164,
      whatsAppNumber,
      whatsAppE164,
      waId,
      country,
      companyName,
      companyLogo,
      profilePicture,
      source,
      clientFor: organizationId,
      password: hashedPassword,
      // mustChangePassword: true, // if you add it to schema
    });

    await newClient.save();
    return res.status(201).json({ client: newClient });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: "Duplicate client",
        details: error.keyValue,
      });
    }

    return res.status(500).json({
      error: "ERROR!",
      message: error.message || "Server Error",
    });
  }
});

module.exports = router;
