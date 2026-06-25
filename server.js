require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const connectDB = require("./config/db");

const app = express();

app.use(cors());
// Stripe webhook needs the raw request body for signature verification — mount before json.
app.use("/api/stripe", require("./routes/api/stripe"));
app.use(express.json());

connectDB();

app.get("/api/health", (req, res) => res.json({ ok: true, service: "codex-crm-api" }));

app.use("/api/auth", require("./routes/api/auth"));
app.use("/api/users", require("./routes/api/users"));
app.use("/api/teams", require("./routes/api/team"));
app.use("/api/organizations", require("./routes/api/organization"));
app.use("/api/customers", require("./routes/api/customers"));
app.use("/api/banks", require("./routes/api/banks"));
app.use("/api/business-lines", require("./routes/api/businessLines"));
app.use("/api/service-categories", require("./routes/api/serviceCategories"));
app.use("/api/services", require("./routes/api/services"));
app.use("/api/quotation-terms", require("./routes/api/quotationTerms"));
app.use("/api/quotations", require("./routes/api/quotations"));
app.use("/api/invoices", require("./routes/api/invoices"));
app.use("/api/projects", require("./routes/api/projects"));
// Customer-portal routes must be mounted BEFORE the broad "/api" internal routers below,
// otherwise their router-level requireRole(INTERNAL) guard rejects customer requests.
app.use("/api/customer-portal", require("./routes/api/customerPortalDashboard"));
app.use("/api/customer-portal", require("./routes/api/customerPortalApprovals"));
app.use("/api/customer-portal", require("./routes/api/customerPortalDeliveries"));
app.use("/api/customer-portal", require("./routes/api/customerPortalComments"));
app.use("/api/customer-portal", require("./routes/api/customerPortalSupport"));
app.use("/api", require("./routes/api/projectSteps"));
app.use("/api", require("./routes/api/projectApprovals"));
app.use("/api", require("./routes/api/projectDeliveries"));
app.use("/api", require("./routes/api/projectComments"));
app.use("/api/support", require("./routes/api/support"));
app.use("/api/contact-messages", require("./routes/api/contactMessages"));
app.use("/api/notifications", require("./routes/api/notifications"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Codex CRM API on :${PORT}`);
});

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  process.exit(0);
});






