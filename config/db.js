require("dotenv").config();

const mongoose = require("mongoose");
const config = require("config");

const db = process.env.mongoURI || config.get("mongoURI");

const connectDB = async () => {
  try {
    await mongoose.connect(db, {
      autoIndex: false,
    });

    console.log("Codex CRM DB server connected");
  } catch (error) {
    console.error(error.message);

    process.exit(1);
  }
};

module.exports = connectDB;
