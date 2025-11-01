const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ResetToken = Schema(
  {
    resetToken: {
      type: String,
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "users",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = Reset = mongoose.model("reset", ResetToken);
