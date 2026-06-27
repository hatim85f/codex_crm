const express = require("express");

const router = express.Router();
const Task = require("../../models/Task");
const TaskActivity = require("../../models/TaskActivity");
const User = require("../../models/User");
const Project = require("../../models/Project");
const { auth, requireRole } = require("../../middleware/auth");
const { canSeeAllLeads: isAdmin, visibleAssigneeIds } = require("../../services/leadsScope");
const { DEPARTMENTS, departmentForRole } = require("../../services/departments");
const { TASK_STATUSES, TASK_TYPES, TASK_PRIORITIES, TASK_RELATED_MODULES } = require("../../models/Task");

// Every internal role can use the Task Center (it's where members see assigned work).
const INTERNAL = ["owner_admin", "admin", "sales", "marketing", "team_leader",
  "developer", "designer", "content_creator", "accountant", "support"];
const MANAGE = ["owner_admin", "admin", "team_leader"];

router.use(auth);
router.use(requireRole(...INTERNAL));

const POPULATE = [
  { path: "assignedTo", select: "name email avatar" },
  { path: "createdBy", select: "name avatar" },
];

// Ids of projects this user leads (any role can lead a project).
async function ledProjectIds(req) {
  const projs = await Project.find({
    organization: req.user.organization,
    projectLeaderId: req.user.id,
    isDeleted: false,
  }).select("_id assignedMembers");
  return projs;
}

// People whose tasks this (non-admin) user may see / assign to:
//   self  +  team members (if team_leader)  +  members of projects they lead.
async function visibleIdsForTasks(req) {
  const ids = new Set(await visibleAssigneeIds(req)); // self (+ team members for team_leader)
  const projs = await ledProjectIds(req);
  projs.forEach((p) => (p.assignedMembers || []).forEach((m) => m && ids.add(String(m))));
  return [...ids];
}

// Visibility clause for the task list, or null for admins (who see everything).
//   - owner_admin / admin -> all
//   - everyone else       -> tasks for their people OR tasks on projects they lead
async function taskScope(req) {
  if (isAdmin(req)) return null;
  const ids = await visibleIdsForTasks(req);
  const or = [{ assignedTo: { $in: ids } }, { createdBy: { $in: ids } }];
  const projs = await ledProjectIds(req);
  if (projs.length) {
    or.push({
      relatedModule: { $in: ["project", "project_step"] },
      relatedRecordId: { $in: projs.map((p) => p._id) },
    });
  }
  return { $or: or };
}

// Resolve a task's department: explicit value wins, else derive from the assignee's role.
async function resolveDepartment(department, assignedTo) {
  if (DEPARTMENTS.includes(department)) return department;
  if (assignedTo) {
    const u = await User.findById(assignedTo).select("role");
    if (u) return departmentForRole(u.role);
  }
  return "general";
}

async function logActivity(req, taskId, type, extra = {}) {
  try {
    await TaskActivity.create({
      organization: req.user.organization,
      taskId,
      type,
      message: extra.message || "",
      oldValue: extra.oldValue || "",
      newValue: extra.newValue || "",
      createdBy: req.user.id,
    });
  } catch (e) {
    console.error("task activity log error:", e.message);
  }
}

async function loadTask(req, res) {
  const task = await Task.findById(req.params.id).populate(POPULATE);
  if (!task || task.isDeleted || String(task.organization) !== String(req.user.organization)) {
    res.status(404).json({ message: "Task not found" });
    return null;
  }
  const scope = await taskScope(req);
  if (scope) {
    const ok = await Task.exists({ _id: task._id, ...scope });
    if (!ok) { res.status(404).json({ message: "Task not found" }); return null; }
  }
  return task;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

// GET /tasks  (filters: status, type, priority, assignedTo, relatedModule, search, dueFrom, dueTo)
router.get("/", async (req, res) => {
  try {
    const { status, type, priority, assignedTo, relatedModule, department, search, dueFrom, dueTo } = req.query;
    const query = { organization: req.user.organization, isDeleted: false };
    if (status) query.status = status;
    if (type) query.type = type;
    if (priority) query.priority = priority;
    if (assignedTo) query.assignedTo = assignedTo;
    if (relatedModule) query.relatedModule = relatedModule;
    if (department) query.department = department;
    if (dueFrom || dueTo) {
      query.dueDate = {};
      if (dueFrom) query.dueDate.$gte = new Date(dueFrom);
      if (dueTo) query.dueDate.$lte = new Date(dueTo);
    }
    const and = [];
    const scope = await taskScope(req);
    if (scope) and.push(scope);
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      and.push({ $or: [{ title: rx }, { relatedLabel: rx }, { description: rx }] });
    }
    if (and.length) query.$and = and;
    const items = await Task.find(query).populate(POPULATE).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("list tasks error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /tasks/summary  (the overview stat cards) — must precede /:id
router.get("/summary", async (req, res) => {
  try {
    const me = req.user.id;
    const base = { organization: req.user.organization, isDeleted: false };
    const scope = await taskScope(req);
    const visible = scope ? { ...base, ...scope } : base;
    const open = ["todo", "in_progress", "waiting_customer", "waiting_internal"];
    const [myOpen, assigned, overdue, dueToday, waiting, completed] = await Promise.all([
      Task.countDocuments({ ...base, assignedTo: me, status: { $in: open } }),
      Task.countDocuments({ ...base, assignedTo: me }),
      Task.countDocuments({ ...visible, status: { $nin: ["completed", "cancelled"] }, dueDate: { $lt: new Date() } }),
      Task.countDocuments({ ...visible, status: { $nin: ["completed", "cancelled"] }, dueDate: { $gte: startOfToday(), $lte: endOfToday() } }),
      Task.countDocuments({ ...visible, status: { $in: ["waiting_customer", "waiting_internal"] } }),
      Task.countDocuments({ ...visible, status: "completed" }),
    ]);
    return res.json({ myOpen, assigned, overdue, dueToday, waiting, completed });
  } catch (err) {
    console.error("task summary error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /tasks/my-tasks  — tasks assigned to the current user (FE groups them)
router.get("/my-tasks", async (req, res) => {
  try {
    const items = await Task.find({
      organization: req.user.organization,
      isDeleted: false,
      assignedTo: req.user.id,
    }).populate(POPULATE).sort({ dueDate: 1, createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error("my-tasks error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /tasks
router.post("/", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ message: "Title is required" });

    // Who can assign to whom:
    //   owner_admin / admin -> anyone
    //   team_leader / project leader -> their team + members of projects they lead
    //   everyone else -> only themselves
    let assignedTo = b.assignedTo || null;
    if (!isAdmin(req)) {
      const allowed = await visibleIdsForTasks(req); // self + team + led-project members
      if (assignedTo && !allowed.includes(String(assignedTo))) {
        return res.status(403).json({ message: "You can only assign tasks to yourself, your team, or members of projects you lead." });
      }
    }

    const department = await resolveDepartment(b.department, assignedTo);
    const taskNumber = (await Task.countDocuments({ organization: req.user.organization })) + 1001;
    const task = await Task.create({
      organization: req.user.organization,
      taskNumber,
      title: b.title,
      description: b.description || "",
      department,
      type: TASK_TYPES.includes(b.type) ? b.type : "general_task",
      relatedModule: TASK_RELATED_MODULES.includes(b.relatedModule) ? b.relatedModule : "none",
      relatedRecordId: b.relatedRecordId || null,
      relatedLabel: b.relatedLabel || "",
      contactName: b.contactName || "",
      contactPhone: b.contactPhone || "",
      assignedTo,
      createdBy: req.user.id,
      updatedBy: req.user.id,
      priority: TASK_PRIORITIES.includes(b.priority) ? b.priority : "medium",
      status: TASK_STATUSES.includes(b.status) ? b.status : "todo",
      dueDate: b.dueDate || null,
      reminderDate: b.reminderDate || null,
      internalNotes: b.internalNotes || "",
      attachments: Array.isArray(b.attachments) ? b.attachments.map((a) => ({ ...a, uploadedBy: req.user.id })) : [],
    });
    await logActivity(req, task._id, "created", { message: "Task created" });
    const out = await Task.findById(task._id).populate(POPULATE);
    return res.status(201).json(out);
  } catch (err) {
    console.error("create task error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /tasks/:id
router.get("/:id", async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    return res.json(task);
  } catch (err) {
    console.error("get task error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /tasks/:id  (general edit; logs reschedule/reassign when those change)
router.patch("/:id", async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    const b = req.body || {};
    const prevDue = task.dueDate ? new Date(task.dueDate).getTime() : null;
    const prevReminder = task.reminderDate ? new Date(task.reminderDate).getTime() : null;
    const prevAssignee = String(task.assignedTo?._id || task.assignedTo || "");

    const fields = ["title", "description", "type", "relatedModule", "relatedRecordId",
      "relatedLabel", "contactName", "contactPhone", "priority", "dueDate", "reminderDate", "internalNotes"];
    fields.forEach((f) => { if (b[f] !== undefined) task[f] = b[f]; });

    // Rescheduling re-arms the reminder/overdue notifications so they fire again.
    const newReminder = task.reminderDate ? new Date(task.reminderDate).getTime() : null;
    if (b.reminderDate !== undefined && newReminder !== prevReminder) task.reminderSentAt = null;
    const nextDue = task.dueDate ? new Date(task.dueDate).getTime() : null;
    if (b.dueDate !== undefined && nextDue !== prevDue) task.overdueNotifiedAt = null;
    if (DEPARTMENTS.includes(b.department)) task.department = b.department;
    if (b.assignedTo !== undefined) {
      const next = b.assignedTo || null;
      if (next && !isAdmin(req)) {
        const allowed = await visibleIdsForTasks(req);
        if (!allowed.includes(String(next))) {
          return res.status(403).json({ message: "You can only assign tasks to yourself, your team, or members of projects you lead." });
        }
      }
      task.assignedTo = next;
      // Re-derive department from the new assignee unless it was set explicitly.
      if (!DEPARTMENTS.includes(b.department)) task.department = await resolveDepartment(null, next);
    }
    task.updatedBy = req.user.id;
    await task.save();

    const newDue = task.dueDate ? new Date(task.dueDate).getTime() : null;
    if (b.dueDate !== undefined && newDue !== prevDue) {
      await logActivity(req, task._id, "rescheduled", { message: "Due date updated" });
    }
    if (b.assignedTo !== undefined && String(task.assignedTo || "") !== prevAssignee) {
      const u = task.assignedTo ? await User.findById(task.assignedTo).select("name") : null;
      await logActivity(req, task._id, "reassigned", { newValue: u?.name || "Unassigned" });
    }
    const out = await Task.findById(task._id).populate(POPULATE);
    return res.json(out);
  } catch (err) {
    console.error("update task error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// DELETE /tasks/:id (soft)
router.delete("/:id", requireRole(...MANAGE), async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    task.isDeleted = true;
    task.updatedBy = req.user.id;
    await task.save();
    return res.json({ ok: true, _id: task._id });
  } catch (err) {
    console.error("delete task error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /tasks/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!TASK_STATUSES.includes(status)) return res.status(400).json({ message: "Invalid status" });
    const task = await loadTask(req, res);
    if (!task) return;
    const old = task.status;
    task.status = status;
    task.completedAt = status === "completed" ? new Date() : null;
    task.cancelledAt = status === "cancelled" ? new Date() : null;
    task.updatedBy = req.user.id;
    await task.save();
    const type = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "status_change";
    await logActivity(req, task._id, type, { oldValue: old, newValue: status });
    return res.json({ ok: true, _id: task._id, status });
  } catch (err) {
    console.error("task status error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// PATCH /tasks/:id/assign
router.patch("/:id/assign", requireRole(...MANAGE), async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    const next = req.body?.assignedTo || null;
    if (next && !isAdmin(req)) {
      const allowed = await visibleIdsForTasks(req);
      if (!allowed.includes(String(next))) {
        return res.status(403).json({ message: "You can only assign tasks to yourself, your team, or members of projects you lead." });
      }
    }
    const prev = task.assignedTo ? await User.findById(task.assignedTo).select("name") : null;
    task.assignedTo = next;
    task.department = await resolveDepartment(null, next);
    task.updatedBy = req.user.id;
    await task.save();
    const nextUser = task.assignedTo ? await User.findById(task.assignedTo).select("name") : null;
    await logActivity(req, task._id, "reassigned", { oldValue: prev?.name || "Unassigned", newValue: nextUser?.name || "Unassigned" });
    const out = await Task.findById(task._id).populate(POPULATE);
    return res.json(out);
  } catch (err) {
    console.error("task assign error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /tasks/:id/comments  { message }
router.post("/:id/comments", async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ message: "Comment is required" });
    await logActivity(req, task._id, "comment", { message });
    const out = await TaskActivity.findOne({ taskId: task._id, type: "comment" }).sort({ createdAt: -1 }).populate("createdBy", "name avatar");
    return res.status(201).json(out);
  } catch (err) {
    console.error("task comment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /tasks/:id/attachments  { fileName, fileUrl, fileType, fileSize }
router.post("/:id/attachments", async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    const b = req.body || {};
    if (!b.fileUrl) return res.status(400).json({ message: "fileUrl is required" });
    task.attachments.push({ fileName: b.fileName || "Attachment", fileUrl: b.fileUrl, fileType: b.fileType || "", fileSize: b.fileSize || 0, uploadedBy: req.user.id });
    task.updatedBy = req.user.id;
    await task.save();
    await logActivity(req, task._id, "attachment", { message: b.fileName || "Attachment added" });
    const out = await Task.findById(task._id).populate(POPULATE);
    return res.status(201).json(out);
  } catch (err) {
    console.error("task attachment error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /tasks/:id/activities
router.get("/:id/activities", async (req, res) => {
  try {
    const task = await loadTask(req, res);
    if (!task) return;
    const items = await TaskActivity.find({ organization: req.user.organization, taskId: task._id })
      .populate("createdBy", "name avatar").sort({ createdAt: 1 });
    return res.json(items);
  } catch (err) {
    console.error("task activities error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
