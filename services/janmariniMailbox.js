// Polls all configured Janmarini-related inboxes for new mail, uploads any
// attachments to Cloudinary, and returns them for the Claude review pass to
// read and match against Shopify orders.
//
// All mailboxes use the date-cursor strategy (MailboxSyncState), NOT the
// \Seen flag: even "dedicated" mailboxes get opened in a webmail client from
// time to time to eyeball what's there, which silently marks everything
// \Seen and would make an unseen-flag-based sync miss real mail forever.
// Date cursors are unaffected by anyone just reading the mailbox.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { uploadBufferToCloudinary } = require("./cloudinaryUpload");
const MailboxSyncState = require("../models/janmarini/MailboxSyncState");

const LOOKBACK_DAYS = Number(process.env.MAILBOX_SYNC_LOOKBACK_DAYS || 7);

const MAILBOX_CONFIGS = [
  {
    source: "mariniorders",
    strategy: "dateCursor", // Hatim's manual uploads — everything here is relevant, no keyword filter needed
    hostVar: "MARINI_IMAP_HOST",
    portVar: "MARINI_IMAP_PORT",
    userVar: "MARINI_IMAP_USER",
    passVar: "MARINI_IMAP_PASS",
  },
  {
    source: "ebay",
    strategy: "dateCursor", // personal inbox — never mark \Seen, never bulk-fetch unseen
    host: "imap.gmail.com",
    port: 993,
    userVar: "EBAY_GMAIL_USER",
    passVar: "EBAY_GMAIL_APP_PASSWORD",
    searchFrom: "ebay",
  },
  {
    // info@ is a general business inbox (also gets spam/sales mail), not
    // dedicated to Shop & Ship — same date-cursor treatment. We don't yet know
    // Shop & Ship's exact sender address, so instead of an IMAP `from` filter
    // we do a cheap envelope-only pass first and keyword-match the subject
    // before downloading full message bodies.
    source: "shopandship",
    strategy: "dateCursor",
    hostVar: "MARINI_IMAP_HOST", // same cPanel host as mariniorders
    portVar: "MARINI_IMAP_PORT",
    user: "info@codex-fze.com",
    passVar: "INFO_EMAIL_PASS",
    keywords: ["aramex", "shop & ship", "shopandship", "shop and ship", "waybill", "shipment"],
  },
];

function resolveConfig(cfg) {
  const host = cfg.host || process.env[cfg.hostVar];
  const port = Number(cfg.port || process.env[cfg.portVar] || 993);
  const user = cfg.user || process.env[cfg.userVar];
  const pass = process.env[cfg.passVar];
  return { ...cfg, host, port, user, pass };
}

// Only returns mailboxes whose credentials are actually configured — lets the
// sync skip individual inboxes gracefully instead of failing the whole run.
function getConfiguredMailboxes() {
  return MAILBOX_CONFIGS.map(resolveConfig).filter((m) => m.host && m.user && m.pass);
}

async function parseMessage(source, message) {
  const parsed = await simpleParser(message.source);
  const attachments = [];
  for (const att of parsed.attachments || []) {
    const url = await uploadBufferToCloudinary(att.content, att.filename || "attachment", att.contentType);
    attachments.push({ fileName: att.filename || "attachment", url });
  }
  return {
    source,
    messageUid: message.uid,
    messageId: parsed.messageId || "",
    subject: parsed.subject || "",
    from: parsed.from?.text || "",
    date: parsed.date || null,
    bodyText: parsed.text || "",
    attachments,
  };
}

async function fetchUnseenFromMailbox(cfg) {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
  const results = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const state = await MailboxSyncState.findOne({ source: cfg.source });
      const since = state?.lastMessageDate || new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      // Passing the search criteria straight to .fetch() has been observed to
      // hang — search for UIDs explicitly first, then fetch that UID list.
      const searchQuery = cfg.searchFrom ? { from: cfg.searchFrom, since } : { since };
      const uids = await client.search(searchQuery);

      // One cheap envelope-only pass: advances the date cursor across EVERY
      // message in the window (so skipped/irrelevant mail isn't rescanned
      // every run) and — if this mailbox has no reliable `from` filter —
      // narrows down to keyword-matching candidates before downloading any
      // full message bodies.
      let maxDate = since;
      let candidateUids = uids;
      if (uids.length && cfg.keywords?.length) {
        candidateUids = [];
        for await (const message of client.fetch(uids, { uid: true, envelope: true })) {
          if (message.envelope?.date && message.envelope.date > maxDate) maxDate = message.envelope.date;
          const haystack = `${message.envelope?.subject || ""} ${message.envelope?.from?.[0]?.address || ""}`.toLowerCase();
          if (cfg.keywords.some((k) => haystack.includes(k))) candidateUids.push(message.uid);
        }
      } else if (uids.length) {
        for await (const message of client.fetch(uids, { uid: true, envelope: true })) {
          if (message.envelope?.date && message.envelope.date > maxDate) maxDate = message.envelope.date;
        }
      }

      if (candidateUids.length) {
        for await (const message of client.fetch(candidateUids, { source: true, uid: true, envelope: true })) {
          const parsed = await parseMessage(cfg.source, message);
          // `since` is day-granularity in IMAP SEARCH — re-check exact time
          // so we don't reprocess the same message every run.
          if (parsed.date && parsed.date <= since) continue;
          results.push(parsed);
        }
      }

      await MailboxSyncState.findOneAndUpdate({ source: cfg.source }, { lastMessageDate: maxDate }, { upsert: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results;
}

// Returns { messages, errors, mailboxesChecked } across every configured
// mailbox. One mailbox failing (bad creds, network hiccup) doesn't block the
// others — its error is attached to the result set instead of throwing.
async function fetchUnseenReceipts() {
  const mailboxes = getConfiguredMailboxes();
  const all = [];
  const errors = [];

  for (const mailbox of mailboxes) {
    const t0 = Date.now();
    console.log(`[janmarini] mailbox sync: starting ${mailbox.source}`);
    try {
      const r = await fetchUnseenFromMailbox(mailbox);
      console.log(`[janmarini] mailbox sync: finished ${mailbox.source} in ${Date.now() - t0}ms, ${r.length} messages`);
      all.push(...r);
    } catch (e) {
      console.log(`[janmarini] mailbox sync: FAILED ${mailbox.source} after ${Date.now() - t0}ms: ${e.message}`);
      errors.push({ source: mailbox.source, error: e.message });
    }
  }

  return { messages: all, errors, mailboxesChecked: mailboxes.map((m) => m.source) };
}

module.exports = { fetchUnseenReceipts, getConfiguredMailboxes };
