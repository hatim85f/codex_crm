const mongoose = require("mongoose");
const connectDB = require("./config/db");

const start = async () => {
  await connectDB();
  console.log("Codex CRM base server is ready");
};

start();

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
