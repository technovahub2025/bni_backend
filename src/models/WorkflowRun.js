const mongoose = require("mongoose");

const WorkflowRunSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workflow",
      required: true
    },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },
    currentStep: { type: String, default: "template_1" },
    templateConfig: {
      template1: { type: String, default: "template_1" },
      template2: { type: String, default: "template_2" },
      template3: { type: String, default: "template_3" },
      template2DelayValue: { type: Number, default: 24 },
      template2DelayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "hours" },
      template3DelayValue: { type: Number, default: 48 },
      template3DelayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "hours" },
      membershipTemplate: { type: String, default: "membership_application_template" },
      applicationSubmittedTemplate: { type: String, default: "whatsapp_automation_request_info" },
      meetingTemplate: { type: String, default: "meeting_booking_template" },
      meetingReminderTemplate: { type: String, default: "meeting_reminder_template" }
    },
    currentStepIndex: { type: Number, default: 0 },
    state: {
      type: String,
      enum: ["running", "completed", "stopped"],
      default: "running"
    }
  },
  { timestamps: true }
);

WorkflowRunSchema.index({ leadId: 1, state: 1 });

module.exports = mongoose.model("WorkflowRun", WorkflowRunSchema);
