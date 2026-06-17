require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const connectDB = require("./config/db");

const app = express();

app.use(cors());
app.use(express.json());

connectDB();

app.get("/api/health", (req, res) => res.json({ ok: true, service: "codex-crm-api" }));

app.use("/api/auth", require("./routes/api/auth"));
app.use("/api/users", require("./routes/api/users"));
app.use("/api/teams", require("./routes/api/team"));
app.use("/api/organizations", require("./routes/api/organization"));
app.use("/api/customers", require("./routes/api/customers"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Codex CRM API on :${PORT}`);
});

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
