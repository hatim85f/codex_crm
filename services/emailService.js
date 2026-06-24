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
  sendCustomerActivation,
  sendTeamInvitation,
  sendForgotPassword,
  sendQuotationPortal,
  sendInvoicePortal,
  sendProjectApprovalRequest,
};
