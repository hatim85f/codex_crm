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

module.exports = router;
