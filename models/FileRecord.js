const mongoose = require("mongoose");

const { Schema } = mongoose;

// File category (derived from mime/extension) used for the type badge + filters.
const FILE_TYPES = ["pdf", "doc", "sheet", "presentation", "image", "video", "audio", "archive", "other"];

// Every CRM record a file can be linked to. "none" = an unlinked file.
const FILE_RELATED_MODULES = [
  "none", "customer", "potential_customer", "whatsapp_conversation", "meta_lead",
  "project", "project_step", "approval_request", "final_delivery", "task",
  "support_conversation", "contact_message", "quotation", "invoice",
];

const FILE_VISIBILITIES = ["internal_only", "shared_with_customer"];

const FileRecordSchema = new Schema(
  {
    organization: { type: Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
    fileNumber: { type: Number, index: true }, // display code FIL-{fileNumber}

    fileName: { type: String, required: true, trim: true }, // display / custom name
    originalName: { type: String, default: "" },
    fileType: { type: String, enum: FILE_TYPES, default: "other", index: true },
    mimeType: { type: String, default: "" },
    fileUrl: { type: String, required: true },
    fileSize: { type: Number, default: 0 }, // bytes
    description: { type: String, default: "" },

    // Polymorphic link to any CRM record (denormalized label for fast display).
    relatedModule: { type: String, enum: FILE_RELATED_MODULES, default: "none", index: true },
    relatedRecordId: { type: Schema.Types.ObjectId, default: null, index: true },
    relatedLabel: { type: String, default: "" },

    // internal_only NEVER reaches the customer portal; shared_with_customer may
    // surface only in the matching customer/project context.
    visibility: { type: String, enum: FILE_VISIBILITIES, default: "internal_only", index: true },

    tags: { type: [String], default: [] },

    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    isArchived: { type: Boolean, default: false, index: true },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

FileRecordSchema.index({ organization: 1, relatedModule: 1, relatedRecordId: 1 });
FileRecordSchema.index({ organization: 1, isDeleted: 1, isArchived: 1, createdAt: -1 });

module.exports = mongoose.model("FileRecord", FileRecordSchema);
module.exports.FILE_TYPES = FILE_TYPES;
module.exports.FILE_RELATED_MODULES = FILE_RELATED_MODULES;
module.exports.FILE_VISIBILITIES = FILE_VISIBILITIES;
