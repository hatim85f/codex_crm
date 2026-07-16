const mongoose = require("mongoose");

const { Schema } = mongoose;

const TASK_TYPES = [
  "follow_up", "call", "whatsapp_reply", "email", "meeting",
  "technical_task", "project_step", "approval_follow_up",
  "invoice_follow_up", "support_task", "general_task",
];
const TASK_STATUSES = [
  "todo", "scheduled", "in_progress", "submitted_for_approval", "changes_requested",
  "approved", "cancelled", "overdue",
  // legacy (kept so older records still validate)
  "waiting_customer", "waiting_internal", "completed",
];
const APPROVAL_STATUSES = ["none", "pending", "approved", "changes_requested"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

// Every CRM record a task can be linked to. "none" = a standalone manual task.
const RELATED_MODULES = [
  "none", "potential_customer", "whatsapp_conversation", "meta_lead",
  "customer", "project", "project_step", "quotation", "invoice",
  "support_conversation", "contact_message",
];

const AttachmentSchema = new Schema(
  {
    fileName: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const TaskSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    taskNumber: { type: Number, index: true }, // display code TSK-{taskNumber}

    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    type: { type: String, enum: TASK_TYPES, default: "general_task", index: true },

    // Business-form grouping for the manager/admin Task Center (derived from the
    // assignee's role unless set explicitly). See services/departments.js.
    department: {
      type: String,
      enum: ["general", "sales", "marketing", "development", "design", "content", "accounting", "support", "management"],
      default: "general",
      index: true,
    },

    // Polymorphic link to any CRM record (denormalized label for fast display).
    relatedModule: { type: String, enum: RELATED_MODULES, default: "none", index: true },
    relatedRecordId: { type: Schema.Types.ObjectId, default: null, index: true },
    relatedLabel: { type: String, default: "" },

    // Contact to reach for call / whatsapp_reply tasks (so an assigned member can
    // act without access to the WhatsApp inbox or the lead record).
    contactName: { type: String, default: "" },
    contactPhone: { type: String, default: "" },

    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    priority: { type: String, enum: PRIORITIES, default: "medium", index: true },
    status: { type: String, enum: TASK_STATUSES, default: "todo", index: true },

    dueDate: { type: Date, default: null, index: true },
    scheduledDate: { type: Date, default: null, index: true }, // planned work start (legacy field name retained)
    scheduledEndDate: { type: Date, default: null, index: true },
    plannedMinutes: { type: Number, min: 15, max: 43200, default: 60 }, // up to 30 continuous days
    reminderDate: { type: Date, default: null },

    // Approval workflow — employees submit; the approver (project lead / admin) decides.
    approvalStatus: { type: String, enum: APPROVAL_STATUSES, default: "none", index: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null }, // resolved on submit
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    completionNotes: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewComment: { type: String, default: "" },

    // Set when the reminder / overdue notification has been sent, so the
    // background sweep delivers each one exactly once. See services/taskReminders.js.
    reminderSentAt: { type: Date, default: null },
    overdueNotifiedAt: { type: Date, default: null },

    attachments: { type: [AttachmentSchema], default: [] },
    internalNotes: { type: String, default: "" },

    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

TaskSchema.index({ organization: 1, status: 1, dueDate: 1 });
TaskSchema.index({ organization: 1, assignedTo: 1, status: 1 });

module.exports = mongoose.model("Task", TaskSchema);
module.exports.TASK_TYPES = TASK_TYPES;
module.exports.TASK_STATUSES = TASK_STATUSES;
module.exports.TASK_APPROVAL_STATUSES = APPROVAL_STATUSES;
module.exports.TASK_PRIORITIES = PRIORITIES;
module.exports.TASK_RELATED_MODULES = RELATED_MODULES;
