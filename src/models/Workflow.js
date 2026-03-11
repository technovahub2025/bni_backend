const mongoose = require("mongoose");

const TemplateVariableBindingSchema = new mongoose.Schema(
  {
    variable: { type: String, required: true },
    source: {
      type: String,
      enum: [
        "lead_name",
        "application_form_link",
        "zoom_meeting_link",
        "lead_phone",
        "selected_meeting_time"
      ],
      default: "lead_name"
    }
  },
  { _id: false }
);

const ReplyWorkflowStepSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    triggerType: {
      type: String,
      enum: ["user_reply", "button_click"],
      default: "user_reply"
    },
    triggerValue: { type: String, default: "" },
    nextTemplate: { type: String, default: "" },
    nextTemplateVariables: { type: [TemplateVariableBindingSchema], default: [] }
  },
  { _id: false }
);

const WorkflowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ["nurture", "reply_flow"],
      default: "nurture"
    },
    active: { type: Boolean, default: true },
    settings: {
      template1: { type: String, default: "template_1" },
      template2: { type: String, default: "template_2" },
      template3: { type: String, default: "template_3" },
      template2DelayValue: { type: Number, default: 24 },
      template2DelayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "hours" },
      template3DelayValue: { type: Number, default: 48 },
      template3DelayUnit: { type: String, enum: ["minutes", "hours", "days"], default: "hours" },
      membershipTemplate: { type: String, default: "membership_application_template" },
      applicationSubmittedTemplate: { type: String, default: "whatsapp_automation_request_info" },
      replyKeywords: [{ type: String }],
      normalReplyScore: { type: Number, default: 20 },
      keywordReplyScore: { type: Number, default: 50 }
    },
    replyFlow: {
      initialTemplate: { type: String, default: "" },
      initialTemplateVariables: { type: [TemplateVariableBindingSchema], default: [] },
      steps: { type: [ReplyWorkflowStepSchema], default: [] }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Workflow", WorkflowSchema);
