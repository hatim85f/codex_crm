// Reusable Brevo transactional email service.
// Uses BREVO_KEY from .env. Templates are managed in Brevo (do not recreate here).

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

const TEMPLATES = {
  FORGOT_PASSWORD: 3, // params: userName, otp
  TEAM_INVITATION: 4, // params: userName, manager, userEmail, password
  CUSTOMER_ACTIVATION: 7, // params: contactName, customerName, activationLink, portalWebLink, iosAppLink, androidAppLink
  QUOTATION_PORTAL: 9, // params: firstName, lastName, assignedPerso, assigneePhone, fileLink
  INVOICE_PORTAL: 10, // params: firstName, lastName, invoiceNumber, paymentLink
  PROJECT_APPROVAL: 11, // params: firstName, lastName, customerName, projectName, stepName, approvalTitle, approvalMessage, approvalLink, dueDate, teamLeader, companyName
  PROJECT_FINAL_DELIVERY: 12, // params: firstName, lastName, customerName, projectName, deliveryTitle, deliveryMessage, deliveryLink, dueDate, teamLeader, companyName
};

async function sendBrevoEmail({ templateId, to, params }) {
  const key = process.env.BREVO_KEY || process.env.BREVO_API_KEY;
  if (!key) {
    console.error("BREVO_KEY missing — cannot send email");
    throw new Error("Email service not configured");
  }
  const recipients = Array.isArray(to) ? to : [to];

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": key,
    },
    body: JSON.stringify({ templateId, to: recipients, params }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Brevo send failed:", res.status, data);
    throw new Error((data && data.message) || "Failed to send email");
  }
  return data; // { messageId }
}

// Customer account details / activation — Brevo template #7
function sendCustomerActivation({
  email,
  contactName,
  customerName,
  activationLink,
  portalWebLink,
  iosAppLink = "Coming soon",
  androidAppLink = "Coming soon",
}) {
  return sendBrevoEmail({
    templateId: TEMPLATES.CUSTOMER_ACTIVATION,
    to: { email, name: contactName },
    params: { contactName, customerName, activationLink, portalWebLink, iosAppLink, androidAppLink },
  });
}

// Team invitation & account confirmation — Brevo template #4
function sendTeamInvitation({ email, userName, manager, userEmail, password }) {
  return sendBrevoEmail({
    templateId: TEMPLATES.TEAM_INVITATION,
    to: { email, name: userName },
    params: { userName, manager, userEmail, password },
  });
}

// Quotation available on portal — Brevo template #9
function sendQuotationPortal({ email, firstName, lastName, assignedPerso, assigneePhone, fileLink }) {
  return sendBrevoEmail({
    templateId: TEMPLATES.QUOTATION_PORTAL,
    to: { email, name: `${firstName || ""} ${lastName || ""}`.trim() || email },
    params: {
      firstName: firstName || "",
      lastName: lastName || "",
      assignedPerso: assignedPerso || "our team",
      assigneePhone: assigneePhone || "",
      fileLink: fileLink || "",
    },
  });
}

// Invoice available on portal — Brevo template #10
function sendInvoicePortal({ email, recipients, firstName, lastName, invoiceNumber, paymentLink }) {
  const to = Array.isArray(recipients) && recipients.length
    ? recipients
    : { email, name: `${firstName || ""} ${lastName || ""}`.trim() || email };
  return sendBrevoEmail({
    templateId: TEMPLATES.INVOICE_PORTAL,
    to,
    params: {
      firstName: firstName || "",
      lastName: lastName || "",
      invoiceNumber: invoiceNumber || "",
      paymentLink: paymentLink || "",
    },
  });
}

// Project step requires customer approval — Brevo template #11
function sendProjectApprovalRequest({ email, recipients, firstName, lastName, customerName, projectName, stepName, approvalTitle, approvalMessage, approvalLink, dueDate, teamLeader, companyName }) {
  const to = Array.isArray(recipients) && recipients.length
    ? recipients
    : { email, name: `${firstName || ""} ${lastName || ""}`.trim() || email };
  return sendBrevoEmail({
    templateId: TEMPLATES.PROJECT_APPROVAL,
    to,
    params: {
      firstName: firstName || "",
      lastName: lastName || "",
      customerName: customerName || "",
      projectName: projectName || "",
      stepName: stepName || "",
      approvalTitle: approvalTitle || "",
      approvalMessage: approvalMessage || "",
      approvalLink: approvalLink || "",
      dueDate: dueDate || "—",
      teamLeader: teamLeader || "our team",
      companyName: companyName || "Codex",
    },
  });
}

// Project final delivery ready for customer approval — Brevo template #12 (project_final_delivery_request)
function sendProjectFinalDelivery({ email, recipients, firstName, lastName, customerName, projectName, deliveryTitle, deliveryMessage, deliveryLink, dueDate, teamLeader, companyName }) {
  const to = Array.isArray(recipients) && recipients.length
    ? recipients
    : { email, name: `${firstName || ""} ${lastName || ""}`.trim() || email };
  return sendBrevoEmail({
    templateId: TEMPLATES.PROJECT_FINAL_DELIVERY,
    to,
    params: {
      firstName: firstName || "",
      lastName: lastName || "",
      customerName: customerName || "",
      projectName: projectName || "",
      deliveryTitle: deliveryTitle || "",
      deliveryMessage: deliveryMessage || "",
      deliveryLink: deliveryLink || "",
      dueDate: dueDate || "—",
      teamLeader: teamLeader || "our team",
      companyName: companyName || "Codex",
    },
  });
}

// Raw HTML email (no Brevo template) — used as a fallback where no template is configured.
async function sendBrevoRaw({ to, subject, htmlContent, replyTo }) {
  const key = process.env.BREVO_KEY || process.env.BREVO_API_KEY;
  if (!key) {
    console.error("BREVO_KEY missing — cannot send email");
    throw new Error("Email service not configured");
  }
  const recipients = Array.isArray(to) ? to : [to];
  const sender = {
    name: process.env.BREVO_SENDER_NAME || "Codex FZE",
    email: process.env.BREVO_SENDER_EMAIL || "info@codex-fze.com",
  };
  const body = { sender, to: recipients, subject, htmlContent };
  if (replyTo) body.replyTo = replyTo;

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Brevo raw send failed:", res.status, data);
    throw new Error((data && data.message) || "Failed to send email");
  }
  return data;
}

const CATEGORY_LABELS = {
  general_inquiry: "General inquiry",
  project_support: "Project support",
  billing_invoice: "Billing / invoice",
  change_request: "Change request",
  technical_issue: "Technical issue",
  other: "Other",
};

// Customer Contact Us form submission — template key: customer_contact_form_submission.
// No Brevo template id is configured for this, so we send branded raw HTML as the fallback.
function sendContactFormSubmission({ to, params = {} }) {
  const p = params;
  const cat = CATEGORY_LABELS[p.category] || p.category || "—";
  const row = (k, v) => v ? `<tr><td style="padding:6px 0;font-size:12px;color:#647488;width:140px;vertical-align:top;">${k}</td><td style="padding:6px 0;font-size:13px;color:#131E3D;font-weight:600;">${v}</td></tr>` : "";
  const htmlContent = `
<div style="font-family:Arial,Helvetica,sans-serif;background:#F4F6F9;padding:24px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;">
    <tr><td style="background:#0D6666;padding:20px 28px;color:#fff;font-size:16px;font-weight:700;">New Contact Form Submission</td></tr>
    <tr><td style="height:4px;background:#CDAD7D;font-size:4px;line-height:4px;">&nbsp;</td></tr>
    <tr><td style="padding:24px 28px;">
      <p style="margin:0 0 16px;font-size:14px;color:#3A4A5C;">A customer submitted the Contact Us form on the portal.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${row("Name", p.name)}
        ${row("Customer", p.customerName)}
        ${row("Email", p.email)}
        ${row("Phone", p.phone)}
        ${row("Category", cat)}
        ${row("Project", p.projectName)}
        ${row("Subject", p.subject)}
        ${row("Submitted", p.submittedAt)}
      </table>
      <div style="margin-top:18px;padding:16px;background:#F7F9FC;border:1px solid #E6EAF1;border-radius:10px;">
        <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#647488;font-weight:700;">Message</p>
        <p style="margin:0;font-size:14px;color:#131E3D;line-height:21px;white-space:pre-wrap;">${(p.message || "").replace(/</g, "&lt;")}</p>
      </div>
    </td></tr>
    <tr><td style="background:#131E3D;padding:16px 28px;color:#7C86AB;font-size:11px;">${p.companyName || "Codex FZE"} — Customer Portal</td></tr>
  </table>
</div>`;
  return sendBrevoRaw({
    to,
    subject: `[Contact] ${cat}: ${p.subject || "New message"}`,
    htmlContent,
    replyTo: p.email ? { email: p.email, name: p.name || p.email } : undefined,
  });
}

// Forgot password (OTP) — Brevo template #3
function sendForgotPassword({ email, userName, otp }) {
  return sendBrevoEmail({
    templateId: TEMPLATES.FORGOT_PASSWORD,
    to: { email, name: userName },
    params: { userName, otp },
  });
}

module.exports = {
  TEMPLATES,
  sendBrevoEmail,
  sendBrevoRaw,
  sendCustomerActivation,
  sendTeamInvitation,
  sendForgotPassword,
  sendQuotationPortal,
  sendInvoicePortal,
  sendProjectApprovalRequest,
  sendProjectFinalDelivery,
  sendContactFormSubmission,
};
