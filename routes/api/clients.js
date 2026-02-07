const express = require("express");
const router = express.Router();
const { check, validationResult } = require("express-validator");
const Clients = require("../../models/Clients");
const User = require("../../models/User");
const bcrypt = require("bcryptjs");

const auth = require("../../middleware/auth");

const normalizeToE164 = require("../../helpers/normalizeToE164");
const extractWhatsAppIdentity = require("../../helpers/extractWhatsAppIdentity");
const createOrGetClientFromWhatsApp = require("../../helpers/createOrGetClientFromWhatsApp");

const c = require("config");

router.get("/:userId", auth, async (req, res) => {
  const { userId } = req.params;

  try {
    // Get the user's organization ID
    const user = await User.findOne({ _id: userId }).select("organizationId");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get all clients under the same organization
    const companyClients = await Clients.find({
      clientFor: user.organizationId,
    }).sort({
      createdAt: -1,
    });

    const clients = await Clients.find({ handledBy: userId }).sort({
      createdAt: -1,
    });

    // based on createdAt, get the percentage of clients added in the last 30 days

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const clientsAddedLast30Days = await Clients.find({
      clientFor: user.organizationId,
      handledBy: userId,
      createdAt: { $gte: thirtyDaysAgo },
    });

    const percentageAddedLast30Days =
      (clientsAddedLast30Days.length / clients.length) * 100;

    return res.status(200).json({
      companyClients,
      clients,
      clientsPercentage: percentageAddedLast30Days,
    });
  } catch (error) {
    return res.status(500).send({
      error: "Server Error",
      message: "Please try again later." || error.message,
    });
  }
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
    userId,
  } = req.body;

  try {
    const user = await User.findOne({ _id: userId });

    const isClientExists = await Clients.findOne({
      email,
      clientFor: user.organizationId,
    });
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

    // customer  ID generation logic
    const date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const yy = String(date.getFullYear()).slice(-2);

    const lastClient = await Clients.findOne({})
      .sort({ createdAt: -1 })
      .select("customerId");

    let newCustomerIdNumber = 51; // starting number
    if (lastClient && lastClient.customerId) {
      const lastCustomerId = lastClient.customerId;

      const lastNumber = parseInt(lastCustomerId.slice(-4), 10);
      if (!isNaN(lastNumber)) {
        newCustomerIdNumber = lastNumber + 1;
      }
    }
    const newCustomerId = `${mm}${dd}${yy}${String(
      newCustomerIdNumber
    ).padStart(4, "0")}`;

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
      clientFor: user.organizationId,
      password: hashedPassword,
      handledBy: userId,
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

router.post("/whatsapp/test-ad-inbound", auth, async (req, res) => {
  const { userId, payload, countryCode } = req.body;

  try {
    const user = await User.findById(userId).select("organizationId");
    if (!user) return res.status(404).json({ error: "User not found" });

    // payload should be: changes[0].value (ONLY)
    const result = await createOrGetClientFromWhatsApp({
      orgId: user.organizationId,
      handledBy: userId,
      value: payload,
      countryCode: countryCode || "AE",
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: "ERROR!", message: error.message });
  }
});

module.exports = router;
