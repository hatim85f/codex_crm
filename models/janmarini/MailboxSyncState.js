const { Schema } = require("mongoose");
const conn = require("../../config/janmariniDb");

// Tracks per-mailbox sync progress for inboxes where we can't safely rely on
// the \Seen flag (e.g. a personal Gmail account also used for everything
// else) — we advance a date cursor instead of mutating the mailbox's state.
const MailboxSyncStateSchema = new Schema(
  {
    source: { type: String, required: true, unique: true },
    lastMessageDate: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = conn.model("MailboxSyncState", MailboxSyncStateSchema);
