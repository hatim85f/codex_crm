const SibApiV3Sdk = require("sib-api-v3-sdk");
require("dotenv").config();

const brevoClient = SibApiV3Sdk.ApiClient.instance;
brevoClient.authentications["api-key"].apiKey = process.env.BREVO_KEY;

const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendTemplateEmail({ to, name, templateId, params }) {
  return tranEmailApi.sendTransacEmail({
    to: [{ email: to, name }],
    templateId,
    params,
    sender: {
      email: "hatim.fayez@gmail.com",
      name: "Trellex Support Team",
    },
  });
}

module.exports = { sendTemplateEmail };
