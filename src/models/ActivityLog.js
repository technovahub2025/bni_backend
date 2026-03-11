const mongoose = require("mongoose");

const ActivityLogSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowRun", default: null },
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ActivityLog", ActivityLogSchema);
