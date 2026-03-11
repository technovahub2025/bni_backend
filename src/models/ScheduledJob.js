const mongoose = require("mongoose");

const ScheduledJobSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    runId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkflowRun",
      required: true
    },
    executeAt: { type: Date, required: true },
    type: {
      type: String,
      enum: ["send_template_2", "send_template_3", "mark_no_response"],
      required: true
    },
    bullJobId: { type: String, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ScheduledJob", ScheduledJobSchema);
