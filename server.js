const express = require("express");
const connectDB = require("./config/db");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ extended: false }));

// optional: stop favicon noise
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Connect Database
connectDB();

app.get("/", (__req, res) =>
  res.status(200).send("Codex CRM API is running...")
);

app.use("/api/users", require("./routes/api/users"));
app.use("/api/auth", require("./routes/api/auth"));
app.use("/api/teams", require("./routes/api/team"));
app.use("/api/organization", require("./routes/api/organization"));
app.use("/api/edits", require("./routes/api/editings"));

// not found
app.use((req, res, next) => {
  res.status(404).json({ message: "Route not found" });
});

// error handler (so unhandled errors don’t crash silently)
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
