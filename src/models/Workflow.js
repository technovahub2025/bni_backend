const mongoose = require("mongoose");

const WorkflowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
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
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Workflow", WorkflowSchema);
