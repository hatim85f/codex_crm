const express = require("express");

const router = express.Router();
const User = require("../../models/User");
const Customer = require("../../models/Customer");
const Project = require("../../models/Project");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const ContactMessage = require("../../models/ContactMessage");
const { auth } = require("../../middleware/auth");
const { sendContactFormSubmission } = require("../../services/emailService");
const { logActivity } = require("../../services/activityLog");

router.use(auth);

async function customerCtx(req, res) {
  const user = await User.findById(req.user.id);
  if (!user || user.userType !== "customer" || !user.customerId) {
    res.status(403).json({ message: "Not a customer account" });
    return null;
  }
  return user;
}

// Validate an optional project belongs to this customer.
async function ownProjectId(user, projectId) {
  if (!projectId) return null;
  const project = await Project.findOne({ _id: projectId, organization: user.organization, customerId: user.customerId, isDeleted: false });
  return project ? project._id : null;
}

// ---- Support chat ----------------------------------------------------------

// GET /customer-portal/support/conversations
router.get("/support/conversations", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const items = await SupportConversation.find({
      organization: user.organization, customerId: user.customerId, isDeleted: false,
    }).populate("projectId", "projectName").sort({ lastMessageAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("portal support list error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /customer-portal/support/conversations  { projectId?, subject?, message }
router.post("/support/conversations", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const b = req.body || {};
    const projectId = await ownProjectId(user, b.projectId);
    const conv = await SupportConversation.create({
      organization: user.organization,
      customerId: user.customerId,
      customerUserId: user._id,
      projectId,
      subject: String(b.subject || "").trim(),
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: String(b.message || "").trim().slice(0, 120),
    });
    if (b.message && String(b.message).trim()) {
      await SupportMessage.create({
        organization: user.organization,
        conversationId: conv._id,
        customerId: user.customerId,
        projectId,
        senderType: "customer",
        senderCustomerUserId: user._id,
        message: String(b.message).trim(),
        attachments: Array.isArray(b.attachments) ? b.attachments : [],
      });
    }
    logActivity({ organization: user.organization, customerId: user.customerId, type: "support.conversation.opened", message: `${user.name} started a support conversation`, actorId: user._id, actorName: user.name });
    const out = await SupportConversation.findById(conv._id).populate("projectId", "projectName");
    return res.status(201).json(out);
  } catch (err) {
    console.error("portal support create error:", err.message);
    return res.status(400).json({ message: err.message || "Could not start conversation" });
  }
});

async function ownConversation(user, id) {
  return SupportConversation.findOne({ _id: id, organization: user.organization, customerId: user.customerId, isDeleted: false });
}

// GET /customer-portal/support/conversations/:id/messages  (no internal notes)
router.get("/support/conversations/:id/messages", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const conv = await ownConversation(user, req.params.id);
    if (!conv) return res.status(404).json({ message: "Conversation not found" });
    const items = await SupportMessage.find({
      organization: user.organization, conversationId: conv._id, isDeleted: false, isInternalNote: false,
    }).populate("senderUserId", "name avatar").sort({ createdAt: 1 });
    return res.json(items);
  } catch (err) {
    console.error("portal support messages error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /customer-portal/support/conversations/:id/messages  { message, attachments? }
router.post("/support/conversations/:id/messages", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const conv = await ownConversation(user, req.params.id);
    if (!conv) return res.status(404).json({ message: "Conversation not found" });
    const b = req.body || {};
    const text = String(b.message || "").trim();
    const attachments = Array.isArray(b.attachments) ? b.attachments : [];
    if (!text && !attachments.length) return res.status(400).json({ message: "Message is required" });
    const msg = await SupportMessage.create({
      organization: user.organization,
      conversationId: conv._id,
      customerId: user.customerId,
      projectId: conv.projectId,
      senderType: "customer",
      senderCustomerUserId: user._id,
      message: text,
      attachments,
    });
    conv.lastMessageAt = new Date();
    conv.lastMessagePreview = text.slice(0, 120) || "Attachment";
    if (conv.status === "closed") conv.status = "open"; // reopen on new customer reply
    await conv.save();
    return res.status(201).json(msg);
  } catch (err) {
    console.error("portal support send error:", err.message);
    return res.status(400).json({ message: err.message || "Could not send message" });
  }
});

// GET /customer-portal/support/contacts -> dedicated handler + company contacts
router.get("/support/contacts", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const customer = await Customer.findById(user.customerId).populate("assignedTo", "name jobTitle email phone whatsapp avatar");
    const h = customer?.assignedTo || null;
    return res.json({
      handler: h ? { name: h.name, jobTitle: h.jobTitle, email: h.email, phone: h.phone, whatsapp: h.whatsapp, avatar: h.avatar } : null,
      company: {
        email: "info@codex-fze.com",
        phone: process.env.SUPPORT_PHONE || "",
        whatsapp: process.env.SUPPORT_WHATSAPP || "",
      },
    });
  } catch (err) {
    console.error("portal contacts error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ---- Contact Us form -------------------------------------------------------

// POST /customer-portal/contact
router.post("/contact", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const b = req.body || {};
    if (!b.name || !b.email || !b.subject || !b.message) {
      return res.status(400).json({ message: "Name, email, subject and message are required." });
    }
    const projectId = await ownProjectId(user, b.projectId);
    const customer = await Customer.findById(user.customerId).populate("assignedTo", "name email");

    // Resolve the handler: customer account owner, else project leader.
    let handler = customer?.assignedTo || null;
    if (!handler && projectId) {
      const project = await Project.findById(projectId).populate("projectLeaderId", "name email");
      handler = project?.projectLeaderId || null;
    }

    const recipients = [{ email: "info@codex-fze.com", name: "Codex FZE" }];
    if (handler?.email) recipients.push({ email: handler.email, name: handler.name });

    const contact = await ContactMessage.create({
      organization: user.organization,
      customerId: user.customerId,
      customerUserId: user._id,
      assignedHandlerId: handler?._id || null,
      name: String(b.name).trim(),
      email: String(b.email).trim().toLowerCase(),
      phone: String(b.phone || "").trim(),
      projectId,
      category: b.category || "general_inquiry",
      subject: String(b.subject).trim(),
      message: String(b.message).trim(),
      attachments: Array.isArray(b.attachments) ? b.attachments : [],
      status: "new",
      emailSentTo: recipients.map((r) => r.email),
      source: "customer_portal",
    });

    // Best-effort email; never fail the request because of email.
    let emailError = null;
    try {
      const project = projectId ? await Project.findById(projectId).select("projectName") : null;
      const parts = String(b.name).trim().split(/\s+/);
      await sendContactFormSubmission({
        to: recipients,
        params: {
          customerName: customer?.displayName || customer?.companyName || "",
          firstName: parts[0] || "",
          lastName: parts.slice(1).join(" "),
          name: String(b.name).trim(),
          email: contact.email,
          phone: contact.phone,
          projectName: project?.projectName || "",
          category: contact.category,
          subject: contact.subject,
          message: contact.message,
          submittedAt: new Date().toLocaleString("en-GB"),
          companyName: "Codex FZE",
        },
      });
    } catch (e) {
      emailError = e.message || "Email could not be sent";
    }

    logActivity({ organization: user.organization, customerId: user.customerId, type: "contact.message", message: `${user.name} submitted a contact form: ${contact.subject}`, actorId: user._id, actorName: user.name });
    return res.status(201).json({ ok: true, _id: contact._id, emailError });
  } catch (err) {
    console.error("portal contact error:", err.message);
    return res.status(400).json({ message: err.message || "Could not send your message" });
  }
});

// GET /customer-portal/contact  -> this customer's own submissions (status visibility)
router.get("/contact", async (req, res) => {
  try {
    const user = await customerCtx(req, res);
    if (!user) return;
    const items = await ContactMessage.find({
      organization: user.organization, customerId: user.customerId, isDeleted: false,
    }).select("-internalNotes").populate("projectId", "projectName").sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("portal contact list error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
