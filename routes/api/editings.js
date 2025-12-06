const express = require("express");
const router = express.Router();
const Organization = require("../../models/Organization");

router.put("/", async (req, res) => {
  try {
    await Organization.updateMany(
      { _id: "69178bea1b41f1d8cdb21775" },
      {
        $set: {
          social: {
            facebook: {},
            instagram: {},
            whatsapp: {
              enabled: false,
            },
          },
        },
      }
    );

    return res.status(200).send({ message: "Update successful" });
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

router.get("/", async (req, res) => {
  try {
    const organization = await Organization.findOne({
      _id: "69178bea1b41f1d8cdb21775",
    });
    return res.status(200).send(organization);
  } catch (error) {
    return res
      .status(500)
      .send({ error: "ERROR !", message: error.message || "Server Error" });
  }
});

module.exports = router;
