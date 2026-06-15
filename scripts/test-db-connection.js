const mongoose = require("mongoose");
const connectDB = require("../config/db");

const testConnection = async () => {
  try {
    await connectDB();
    await mongoose.connection.db.admin().ping();

    console.log("MongoDB connection test passed");
  } catch (error) {
    console.error("MongoDB connection test failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
};

testConnection();
