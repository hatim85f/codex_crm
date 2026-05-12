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

    const clientsWithNamesPipeline = (match) => [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "users",
          let: { handledById: "$handledBy" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$handledById"] } } },
            {
              $project: {
                firstName: 1,
                lastName: 1,
                fullName: 1,
                email: 1,
                profilePicture: 1,
              },
            },
          ],
          as: "handledByUser",
        },
      },
      {
        $lookup: {
          from: "organizations",
          let: { organizationId: "$clientFor" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$organizationId"] } } },
            {
              $project: {
                organizationName: 1,
                slug: 1,
                logo: 1,
              },
            },
          ],
          as: "clientForOrganization",
        },
      },
      {
        $addFields: {
          handledById: "$handledBy",
          clientForId: "$clientFor",
          handledBy: {
            $let: {
              vars: { user: { $arrayElemAt: ["$handledByUser", 0] } },
              in: {
                _id: "$$user._id",
                firstName: "$$user.firstName",
                lastName: "$$user.lastName",
                fullName: {
                  $ifNull: [
                    "$$user.fullName",
                    {
                      $trim: {
                        input: {
                          $concat: [
                            { $ifNull: ["$$user.firstName", ""] },
                            " ",
                            { $ifNull: ["$$user.lastName", ""] },
                          ],
                        },
                      },
                    },
                  ],
                },
                email: "$$user.email",
                profilePicture: "$$user.profilePicture",
              },
            },
          },
          clientFor: {
            $let: {
              vars: {
                organization: { $arrayElemAt: ["$clientForOrganization", 0] },
              },
              in: {
                _id: "$$organization._id",
                organizationName: "$$organization.organizationName",
                slug: "$$organization.slug",
                logo: "$$organization.logo",
              },
            },
          },
        },
      },
      {
        $project: {
          password: 0,
          handledByUser: 0,
          clientForOrganization: 0,
        },
      },
    ];

    // Get all clients under the same organization
    const companyClients = await Clients.aggregate(
      clientsWithNamesPipeline({
        clientFor: user.organizationId,
      })
    );

    const clients = await Clients.aggregate(
      clientsWithNamesPipeline({ handledBy: user._id })
    );

    // based on createdAt, get the percentage of clients added in the last 30 days

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const clientsAddedLast30Days = await Clients.countDocuments({
      clientFor: user.organizationId,
      handledBy: user._id,
      createdAt: { $gte: thirtyDaysAgo },
    });

    const percentageAddedLast30Days =
      clients.length > 0
        ? (clientsAddedLast30Days / clients.length) * 100
        : 0;

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
      newCustomerIdNumber,
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
      customerId: newCustomerId,
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

router.put("/:clientId", auth, async (req, res) => {
  const { clientId } = req.params;
  const {
    firstName,
    lastName,
    email,
    phone,
    whatsAppNumber,
    country,
    countryCode,
    companyName,
    companyLogo,
    profilePicture,
    source,
    assignedTo,
    tags,
  } = req.body;

  try {
    const client = await Clients.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }

    const updatedFields = {};

    if (firstName !== undefined) updatedFields.firstName = firstName;
    if (lastName !== undefined) updatedFields.lastName = lastName;
    if (email !== undefined) updatedFields.email = email;
    if (companyName !== undefined) updatedFields.companyName = companyName;
    if (companyLogo !== undefined) updatedFields.companyLogo = companyLogo;
    if (profilePicture !== undefined) updatedFields.profilePicture = profilePicture;
    if (source !== undefined) updatedFields.source = source;
    if (assignedTo !== undefined) updatedFields.assignedTo = assignedTo;
    if (tags !== undefined) updatedFields.tags = tags;
    if (country !== undefined) updatedFields.country = country;

    if (phone !== undefined) {
      const code = countryCode || client.country || "AE";
      const phoneE164 = normalizeToE164(phone, code);
      if (!phoneE164) return res.status(400).json({ error: "Invalid phone number" });
      updatedFields.phone = phone;
      updatedFields.phoneE164 = phoneE164;
    }

    if (whatsAppNumber !== undefined) {
      const code = countryCode || client.country || "AE";
      const whatsAppE164 = normalizeToE164(whatsAppNumber, code);
      if (!whatsAppE164) return res.status(400).json({ error: "Invalid WhatsApp number" });
      updatedFields.whatsAppNumber = whatsAppNumber;
      updatedFields.whatsAppE164 = whatsAppE164;
      updatedFields.waId = whatsAppE164.replace("+", "");
    }

    if (firstName !== undefined || lastName !== undefined) {
      updatedFields.displayName = `${firstName || client.firstName} ${lastName || client.lastName}`;
    }

    const updatedClient = await Clients.findByIdAndUpdate(
      clientId,
      { $set: updatedFields },
      { new: true }
    );

    return res.status(200).json({ client: updatedClient });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Duplicate value", details: error.keyValue });
    }
    return res.status(500).json({ error: "Server Error", message: error.message });
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
