const { parsePhoneNumberFromString } = require("libphonenumber-js");

const normalizeToE164 = (phone, countryCode) => {
  if (!phone) return null;

  const phoneNumber = parsePhoneNumberFromString(phone, countryCode);

  if (!phoneNumber || !phoneNumber.isValid()) {
    return null;
  }

  return phoneNumber.format("E.164");
};

module.exports = normalizeToE164;
