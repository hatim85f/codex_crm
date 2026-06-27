const Task = require("../models/Task");
const { createNotification } = require("./notify");

// How often the background sweep runs (ms). Reminders/overdue are checked with
// "<= now", so anything missed while the dyno slept is caught on the next tick.
const SWEEP_INTERVAL_MS = 60 * 1000;

const fmtDate = (d) => {
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch (e) {
    return "";
  }
};

const OPEN = { assignedTo: { $ne: null }, isDeleted: false, status: { $nin: ["completed", "cancelled"] } };

// Claim a task's notification slot atomically so overlapping sweeps never
// double-send, then create the notification only if we won the claim.
async function claimAndNotify(task, field, payload) {
  const r = await Task.updateOne({ _id: task._id, [field]: null }, { $set: { [field]: new Date() } });
  if (!r.modifiedCount) return false;
  await createNotification(payload);
  return true;
}

async function runTaskReminderSweep() {
  const now = new Date();

  // 1) Reminder date has arrived (and not yet sent).
  const dueReminders = await Task.find({ ...OPEN, reminderDate: { $ne: null, $lte: now }, reminderSentAt: null })
    .select("_id title taskNumber dueDate organization assignedTo");
  for (const t of dueReminders) {
    await claimAndNotify(t, "reminderSentAt", {
      organization: t.organization,
      recipientUserId: t.assignedTo,
      type: "task_reminder",
      title: "Task reminder",
      message: `Reminder: "${t.title}"${t.dueDate ? ` — due ${fmtDate(t.dueDate)}` : ""}.`,
      link: `tasks/${t._id}`,
      meta: { taskId: String(t._id), taskNumber: t.taskNumber, kind: "reminder" },
    });
  }

  // 2) Due date has passed (overdue) — notify once.
  const overdue = await Task.find({ ...OPEN, dueDate: { $ne: null, $lt: now }, overdueNotifiedAt: null })
    .select("_id title taskNumber dueDate organization assignedTo");
  for (const t of overdue) {
    await claimAndNotify(t, "overdueNotifiedAt", {
      organization: t.organization,
      recipientUserId: t.assignedTo,
      type: "task_overdue",
      title: "Task overdue",
      message: `"${t.title}" is overdue${t.dueDate ? ` (was due ${fmtDate(t.dueDate)})` : ""}.`,
      link: `tasks/${t._id}`,
      meta: { taskId: String(t._id), taskNumber: t.taskNumber, kind: "overdue" },
    });
  }

  return { reminders: dueReminders.length, overdue: overdue.length };
}

// Start the recurring sweep. Safe to call once at server boot.
function startTaskReminderScheduler() {
  const tick = () => runTaskReminderSweep().catch((e) => console.error("task reminder sweep error:", e.message));
  setTimeout(tick, 10 * 1000); // first run shortly after boot (DB connected)
  setInterval(tick, SWEEP_INTERVAL_MS);
  console.log(`Task reminder scheduler started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}

module.exports = { runTaskReminderSweep, startTaskReminderScheduler };
