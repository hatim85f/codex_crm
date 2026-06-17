const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const Customer = require("../../models/Customer");
const CustomerContact = require("../../models/CustomerContact");
const User = require("../../models/User");
const { auth, requireRole } = require("../../middleware/auth");
const { sendCustomerActivation } = require("../../services/emailService");

const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader"];
const MANAGE = ["owner_admin", "admin"];

const webBase = () =>
  process.env.WEB_BASE_URL || "https://codex-crm-24a42f641a41.herokuapp.com";

const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// All customer routes require an authenticated INTERNAL user (customers are blocked).
router.use(auth);
router.use(requireRole(...INTERNAL));

// Send (or re-send) the activation email for a contact's portal user, with a fresh token.
async function inviteContactUser(contact, customer, req) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const activationTokenHash = hashToken(rawToken);

  let user;
  if (contact.userId) {
    user = await User.findById(contact.userId);
  }
  if (!user) {
    // reuse an existing user with this email if present, else create
    user = await User.findOne({ email: contact.email });
    if (user && user.userType !== "customer") {
      throw new Error("That email already belongs to an internal user.");
    }
    if (!user) {
      user = new User({
        name: contact.name,
        email: contact.email,
        organization: req.user.organization,
        role: "customer",
        userType: "customer",
        customerId: customer._id,
        customerContactId: contact._id,
      });
    }
  }
  user.organization = req.user.organization;
  user.customerId = customer._id;
  user.customerContactId = contact._id;
  user.role = "customer";
  user.userType = "customer";
  user.status = "invited";
  user.mustSetPassword = true;
  user.activationTokenHash = activationTokenHash;
  await user.save();

  contact.userId = user._id;
  contact.portalStatus = "invited";
  await contact.save();

  const activationLink = `${webBase()}/activate-account?token=${rawToken}`;
  await sendCustomerActivation({
    email: contact.email,
    contactName: contact.name,
    customerName: customer.displayName,
    activationLink,
    portalWebLink: webBase(),
  });
  return user;
}

/* ---------------- Customers ---------------- */

// POST /api/customers
router.post("/", requireRole(...MANAGE), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.displayName) return res.status(400).json({ message: "Display name is required" });
    const customer = await Customer.create({
      organization: req.user.organization,
      type: b.type === "individual" ? "individual" : "company",
      displayName: b.displayName,
      companyName: b.companyName || "",
      firstName: b.firstName || "",
      lastName: b.lastName || "",
      businessLine: b.businessLine || "",
      assignedTo: b.assignedTo || null,
      email: b.email || "",
      phone: b.phone || "",
      whatsapp: b.whatsapp || "",
      tax: b.tax || {},
      online: b.online || {},
      notes: b.notes || "",
      status: b.status === "inactive" ? "inactive" : "active",
    });
    return res.status(201).json(customer);
  } catch (err) {
    console.error("create customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/customers  (filters: search, status, type, businessLine, assignedTo)
router.get("/", async (req, res) => {
  try {
    const { search, status, type, businessLine, assignedTo } = req.query;
    const query = { organization: req.user.organization };
    if (status) query.status = status;
    if (type) query.type = type;
    if (businessLine) query.businessLine = businessLine;
    if (assignedTo) query.assignedTo = assignedTo;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      query.$or = [
        { displayName: rx }, { companyName: rx }, { email: rx },
        { phone: rx }, { whatsapp: rx },
      ];
    }
    const customers = await Customer.find(query)
      .populate("assignedTo", "name email")
      .sort({ createdAt: -1 });
    return res.json(customers);
  } catch (err) {
    console.error("list customers error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/customers/:id  (with contacts)
router.get("/:id", async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id).populate("assignedTo", "name email");
    if (!customer || String(customer.organization) !== String(req.user.organization)) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const contacts = await CustomerContact.find({ customerId: customer._id }).sort({ isPrimary: -1, createdAt: 1 });
    return res.json({ customer, contacts });
  } catch (err) {
    console.error("get customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// helper to load a tenant-scoped customer
async function loadCustomer(req, res) {
  const customer = await Customer.findById(req.params.id);
  if (!customer || String(customer.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Customer not found" });
    return null;
  }
  return customer;
}

// PUT /api/customers/:id
router.put("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    const b = req.body || {};
    const fields = ["type", "displayName", "companyName", "firstName", "lastName",
      "businessLine", "assignedTo", "email", "phone", "whatsapp", "tax", "online", "notes", "status"];
    fields.forEach((f) => { if (b[f] !== undefined) customer[f] = b[f]; });
    if (b.assignedTo === "") customer.assignedTo = null;
    await customer.save();
    const out = await Customer.findById(customer._id).populate("assignedTo", "name email");
    return res.json(out);
  } catch (err) {
    console.error("update customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customers/:id/status
router.patch("/:id/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: "status must be active or inactive" });
    }
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    customer.status = status;
    await customer.save();
    return res.json(customer);
  } catch (err) {
    console.error("status customer error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ---------------- Contacts ---------------- */

// POST /api/customers/:id/contacts   (body may include createPortalAccess: true)
router.post("/:id/contacts", requireRole(...MANAGE), async (req, res) => {
  try {
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ message: "Contact name is required" });

    if (b.isPrimary) {
      await CustomerContact.updateMany({ customerId: customer._id }, { isPrimary: false });
    }
    const contact = await CustomerContact.create({
      organization: req.user.organization,
      customerId: customer._id,
      name: b.name,
      title: b.title || "",
      email: b.email || "",
      phone: b.phone || "",
      whatsapp: b.whatsapp || "",
      isPrimary: !!b.isPrimary,
    });

    if (b.createPortalAccess) {
      if (!contact.email) {
        return res.status(400).json({ message: "Contact email is required for portal access" });
      }
      try {
        await inviteContactUser(contact, customer, req);
      } catch (e) {
        return res.status(400).json({ message: e.message, contact });
      }
    }
    return res.status(201).json(contact);
  } catch (err) {
    console.error("add contact error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// load a contact under a tenant-scoped customer
async function loadContact(req, res) {
  const customer = await loadCustomer(req, res);
  if (!customer) return {};
  const contact = await CustomerContact.findById(req.params.contactId);
  if (!contact || String(contact.customerId) !== String(customer._id)) {
    res.status(404).json({ message: "Contact not found" });
    return {};
  }
  return { customer, contact };
}

// PUT /api/customers/:id/contacts/:contactId
router.put("/:id/contacts/:contactId", requireRole(...MANAGE), async (req, res) => {
  try {
    const { customer, contact } = await loadContact(req, res);
    if (!contact) return;
    const b = req.body || {};
    if (b.isPrimary && !contact.isPrimary) {
      await CustomerContact.updateMany({ customerId: customer._id }, { isPrimary: false });
    }
    ["name", "title", "email", "phone", "whatsapp", "isPrimary"].forEach((f) => {
      if (b[f] !== undefined) contact[f] = b[f];
    });
    await contact.save();
    return res.json(contact);
  } catch (err) {
    console.error("edit contact error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customers/:id/contacts/:contactId/status
router.patch("/:id/contacts/:contactId/status", requireRole(...MANAGE), async (req, res) => {
  try {
    const { contact } = await loadContact(req, res);
    if (!contact) return;
    const { status } = req.body || {};
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: "status must be active or inactive" });
    }
    contact.status = status;
    // deactivating a contact also disables its portal user
    if (status === "inactive" && contact.userId) {
      await User.findByIdAndUpdate(contact.userId, { status: "inactive" });
    }
    await contact.save();
    return res.json(contact);
  } catch (err) {
    console.error("contact status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /api/customers/:id/contacts/:contactId/portal-access  -> create + invite
router.post("/:id/contacts/:contactId/portal-access", requireRole(...MANAGE), async (req, res) => {
  try {
    const { customer, contact } = await loadContact(req, res);
    if (!contact) return;
    if (!contact.email) return res.status(400).json({ message: "Contact email is required" });
    if (contact.portalStatus === "active") {
      return res.status(400).json({ message: "Portal access is already active for this contact" });
    }
    await inviteContactUser(contact, customer, req);
    return res.json(contact);
  } catch (err) {
    console.error("portal-access error:", err.message);
    return res.status(400).json({ message: err.message || "Could not create portal access" });
  }
});

// POST /api/customers/:id/contacts/:contactId/resend-activation
router.post("/:id/contacts/:contactId/resend-activation", requireRole(...MANAGE), async (req, res) => {
  try {
    const { customer, contact } = await loadContact(req, res);
    if (!contact) return;
    if (contact.portalStatus !== "invited") {
      return res.status(400).json({ message: "Activation can only be resent while the invite is pending." });
    }
    await inviteContactUser(contact, customer, req);
    return res.json(contact);
  } catch (err) {
    console.error("resend-activation error:", err.message);
    return res.status(400).json({ message: err.message || "Could not resend activation" });
  }
});

module.exports = router;
