// Separate Mongo database on the SAME Atlas cluster as Codex CRM, so the
// Janmarini fulfillment data can be migrated out independently later without
// touching the CRM's own "test" database.
require("dotenv").config();

const mongoose = require("mongoose");
const config = require("config");

const uri = process.env.mongoURI || config.get("mongoURI");

const janmariniConnection = mongoose.createConnection(uri, {
  dbName: "janmarini_fulfillment",
  autoIndex: false,
});

janmariniConnection.on("connected", () => {
  console.log("Janmarini fulfillment DB connected");
});
janmariniConnection.on("error", (err) => {
  console.error("Janmarini fulfillment DB error:", err.message);
});

module.exports = janmariniConnection;
