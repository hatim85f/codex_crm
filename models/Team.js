const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TeamSchema = Schema(
  {
    organization: {
      type: mongoose.Types.ObjectId,
      ref: "organizations",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    members: [
      {
        type: mongoose.Types.ObjectId,
        ref: "users",
      },
    ],
    manager: {
      type: mongoose.Types.ObjectId,
      ref: "users",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = Team = mongoose.model("team", TeamSchema);
