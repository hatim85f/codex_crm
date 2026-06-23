const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const router = express.Router();
const User = require("../../models/User");
const CustomerContact = require("../../models/CustomerContact");
const Customer = require("../../models/Customer");
const Quotation = require("../../models/Quotation");
const Invoice = require("../../models/Invoice");
const { auth, getSecret } = require("../../middleware/auth");
const { createInvoiceCheckoutUrl } = require("../../services/stripe");
const portalWebBase = () => process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com";
const { logActivity } = require("../../services/activityLog");
const { createNotifications } = require("../../services/notify");

async function notifyQuotationResponse({ user, quotation, action }) {
  try {
    const customer = await Customer.findOne({ _id: quotation.customerId, organization: user.organization }).select("displayName assignedTo");
    const verb = action === "accept" ? "accepted" : "rejected";
    await createNotifications({
      organization: user.organization,
      recipientUserIds: [quotation.createdBy, customer?.assignedTo],
      audience: "internal",
      type: action === "accept" ? "quotation.accepted" : "quotation.rejected",
      title: action === "accept" ? "Quotation accepted" : "Quotation rejected",
      message: `${customer?.displayName || user.name} ${verb} quotation ${quotation.quotationNumber}`,
      link: `quotations/${quotation._id}`,
      meta: { quotationId: quotation._id, quotationNumber: quotation.quotationNumber, customerId: quotation.customerId },
    });
  } catch (e) {
    console.error("quotation response notification error:", e.message);
  }
}

const signToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, organization: user.organization },
    getSecret(),
    { expiresIn: "7d" }
  );

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
      "+passwordHash"
    );
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }
    if (user.status === "inactive") {
      return res.status(400).json({ message: "Account is inactive. Contact an admin." });
    }
    if (user.status === "invited") {
      return res.status(400).json({ message: "Activate your account first using the link we emailed you." });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    user.lastLoginAt = new Date();
    await user.save();

    if (user.userType === "customer" && user.customerId) {
      logActivity({
        organization: user.organization,
        customerId: user.customerId,
        type: "customer.login",
        message: `${user.name} signed in to the portal`,
        actorId: user._id,
        actorName: user.name,
      });
    }

    const token = signToken(user);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    console.error("login error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/me
router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate("generalTeams", "name department")
      .populate("organization", "name logo status taxNumber contactEmail contactPhone address")
      .populate(
        "customerId",
        "displayName companyName type status businessLine logo email phone whatsapp online tax"
      );
    if (!user) return res.status(404).json({ message: "User not found" });
    // userType, role, customerId, customerContactId are part of the document.
    return res.json(user);
  } catch (err) {
    console.error("me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/me  -> any user updates THEIR OWN profile (name, phone, password)
router.put("/me", auth, async (req, res) => {
  try {
    const { name, phone, password, avatar, jobTitle, department } = req.body || {};
    const user = await User.findById(req.user.id).select("+passwordHash");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (avatar !== undefined) user.avatar = avatar;
    if (jobTitle !== undefined) user.jobTitle = jobTitle;
    if (department !== undefined) user.department = department;
    if (password) {
      if (String(password).length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }
      user.passwordHash = await bcrypt.hash(password, 10);
      user.mustSetPassword = false;
    }
    await user.save();
    return res.json(user.toJSON());
  } catch (err) {
    console.error("update me error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PUT /api/auth/my-customer -> a customer edits SOME of their own company fields.
// TRN, billing address, status, type and assignment are NOT editable here.
router.put("/my-customer", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.userType !== "customer" || !user.customerId) {
      return res.status(403).json({ message: "Not a customer account" });
    }
    const customer = await Customer.findById(user.customerId);
    if (!customer || String(customer.organization) !== String(user.organization)) {
      return res.status(404).json({ message: "Company not found" });
    }
    const b = req.body || {};
    ["displayName", "companyName", "businessLine", "phone", "whatsapp", "email", "logo"].forEach((f) => {
      if (b[f] !== undefined) customer[f] = b[f];
    });
    if (b.online && typeof b.online === "object") {
      customer.online = customer.online || {};
      ["website", "instagram", "linkedin", "facebook", "x"].forEach((k) => {
        if (b.online[k] !== undefined) customer.online[k] = b.online[k];
      });
    }
    await customer.save();
    logActivity({
      organization: user.organization,
      customerId: customer._id,
      type: "customer.updated",
      message: `${user.name} updated company details`,
      actorId: user._id,
      actorName: user.name,
    });
    return res.json(customer);
  } catch (err) {
    console.error("update my-customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/my-quotations -> quotations shared to this customer's portal
router.get("/my-quotations", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.userType !== "customer" || !user.customerId) {
      return res.status(403).json({ message: "Not a customer account" });
    }
    const quotations = await Quotation.find({
      organization: user.organization,
      customerId: user.customerId,
      sharedToPortal: true,
    })
      .populate("customerId", "displayName companyName email phone tax")
      .populate("contactId", "name email phone")
      .populate("bankAccountId", "bankName accountHolderName accountNumber iban swift currency isPrimary logo branch")
      .sort({ createdAt: -1 });
    return res.json(quotations);
  } catch (err) {
    console.error("my-quotations error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/auth/my-quotations/:id/respond  { action: "accept" | "reject", reason? }
// Lets the portal customer accept or reject a quotation that was shared to them.
router.patch("/my-quotations/:id/respond", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.userType !== "customer" || !user.customerId) {
      return res.status(403).json({ message: "Not a customer account" });
    }
    const { action, reason } = req.body || {};
    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be 'accept' or 'reject'" });
    }
    const quotation = await Quotation.findById(req.params.id);
    if (
      !quotation ||
      String(quotation.organization) !== String(user.organization) ||
      String(quotation.customerId) !== String(user.customerId) ||
      !quotation.sharedToPortal
    ) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    if (quotation.status !== "sent") {
      return res.status(400).json({ message: "This quotation can no longer be accepted or rejected." });
    }

    const now = new Date();
    if (action === "accept") {
      quotation.status = "accepted";
      quotation.acceptedAt = now;
      quotation.history.push({ action: "quotation.accepted", message: `Accepted by ${user.name} (client)`, userId: user._id, at: now });
    } else {
      quotation.status = "rejected";
      quotation.rejectedAt = now;
      quotation.history.push({ action: "quotation.rejected", message: `Rejected by ${user.name} (client)${reason ? `: ${reason}` : ""}`, userId: user._id, at: now });
    }
    await quotation.save();

    logActivity({
      organization: user.organization,
      customerId: user.customerId,
      type: action === "accept" ? "quotation.accepted" : "quotation.rejected",
      message: `${user.name} ${action === "accept" ? "accepted" : "rejected"} quotation ${quotation.quotationNumber}${action === "reject" && reason ? ` (${reason})` : ""}`,
      actorId: user._id,
      actorName: user.name,
    });
    await notifyQuotationResponse({ user, quotation, action });

    const out = await Quotation.findById(quotation._id)
      .populate("customerId", "displayName companyName email phone tax")
      .populate("contactId", "name email phone")
      .populate("bankAccountId", "bankName accountHolderName accountNumber iban swift currency isPrimary logo branch");
    return res.json(out);
  } catch (err) {
    console.error("respond quotation error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/auth/my-invoices -> invoices shared to this customer's portal
router.get("/my-invoices", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.userType !== "customer" || !user.customerId) {
      return res.status(403).json({ message: "Not a customer account" });
    }
    const invoices = await Invoice.find({
      organization: user.organization,
      customerId: user.customerId,
      sharedToPortal: true,
    })
      .populate("customerId", "displayName companyName email phone tax")
      .populate("contactId", "name email phone")
      .populate("bankAccountId", "bankName accountHolderName accountNumber iban swift currency isPrimary logo branch")
      .populate("quotationId", "quotationNumber")
      .sort({ createdAt: -1 });
    return res.json(invoices);
  } catch (err) {
    console.error("my-invoices error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/my-invoices/:id/pay -> customer creates a Stripe checkout link for their own invoice
router.post("/my-invoices/:id/pay", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.userType !== "customer" || !user.customerId) {
      return res.status(403).json({ message: "Not a customer account" });
    }
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || String(invoice.organization) !== String(user.organization) || String(invoice.customerId) !== String(user.customerId) || !invoice.sharedToPortal) {
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (!(invoice.balance > 0)) return res.status(400).json({ message: "This invoice is already paid." });
    const url = await createInvoiceCheckoutUrl(invoice, portalWebBase());
    if (!url) return res.status(503).json({ message: "Online payment is not available right now." });
    invoice.paymentLink = url;
    await invoice.save();
    return res.json({ url });
  } catch (err) {
    console.error("my-invoice pay error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/auth/activate-account  { token, password }  (no expiry on token)
router.post("/activate-account", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "Token and password are required" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const activationTokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const user = await User.findOne({ activationTokenHash }).select("+activationTokenHash");
    if (!user) {
      return res.status(400).json({ message: "This activation link is invalid or has already been used." });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.status = "active";
    user.mustSetPassword = false;
    user.activationTokenHash = undefined;
    await user.save();

    if (user.customerContactId) {
      await CustomerContact.findByIdAndUpdate(user.customerContactId, { portalStatus: "active" });
    }
    if (user.customerId) {
      logActivity({
        organization: user.organization,
        customerId: user.customerId,
        type: "portal.activated",
        message: `${user.name} activated their portal account`,
        actorId: user._id,
        actorName: user.name,
      });
    }

    const jwtToken = signToken(user);
    return res.json({ token: jwtToken, user: user.toJSON() });
  } catch (err) {
    console.error("activate error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

