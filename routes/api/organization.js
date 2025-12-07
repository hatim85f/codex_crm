const express = require("express");
const router = express.Router();
const Organization = require("../../models/Organization");
const auth = require("../../middleware/auth");

router.get("/:userId", auth, async (req, res) => {
  const { userId } = req.params;

  try {
    const organization = await Organization.findOne({ ownerId: userId });

    return res.status(200).send({ organization });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.put("/:orgId", auth, async (req, res) => {
  const { orgId } = req.params;
  const updateData = req.body;

  try {
    const updatedOrganization = await Organization.updateMany(
      orgId,
      updateData,
      { new: true }
    );

    if (!updatedOrganization) {
      return res.status(404).send({ message: "Organization not found" });
    }

    return res.status(200).send({ organization: updatedOrganization });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

// Update WhatsApp integration settings
// adding new route to save whatsapp webhook settings
router.put("/:orgId/whatsapp-webhook", auth, async (req, res) => {
  const { orgId } = req.params;

  const {
    wabaId,
    phoneNumberId,
    displayPhoneNumber,
    accessToken,
    webhookVerifyToken,
  } = req.body;

  try {
    if (!wabaId || !phoneNumberId || !accessToken) {
      return res
        .status(400)
        .json({ message: "Missing required WhatsApp fields" });
    }

    const org = await Organization.findOne({ _id: orgId });
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }

    // make sure social exists
    if (!org.social) {
      org.social = {};
    }

    // save whatsapp settings under org.social.whatsapp
    org.social.whatsapp = {
      wabaId: wabaId.toString(),
      phoneNumberId: phoneNumberId.toString(),
      displayPhoneNumber,
      accessToken,
      webhookVerifyToken,
      enabled: true,
      updatedAt: new Date(),
    };

    await org.save();

    return res.json({
      message: "WhatsApp settings saved successfully",
      whatsapp: org.social.whatsapp,
    });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.put("/:orgId/social-links", auth, async (req, res) => {
  const { orgId } = req.params;
  const { facebook, instagram, tiktok } = req.body;

  try {
    const org = await Organization.findOne({ _id: orgId });
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }

    await Organization.updateOne(
      { _id: orgId },
      {
        social: {
          facebook: facebook || {},
          instagram: instagram || {},
          tiktok: tiktok || {},
        },
      }
    );

    return res.json({ message: "Social links updated successfully" });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

module.exports = router;
