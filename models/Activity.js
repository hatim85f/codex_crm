const mongoose = require("mongoose");

const { Schema } = mongoose;

// A timeline entry attached to a customer. New modules (invoices, projects,
// support) log their own events here later via logActivity().
const ActivitySchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", index: true, required: true },
    type: { type: String, required: true }, // e.g. customer.created, portal.invited, customer.login
    message: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Activity", ActivitySchema);
