const mongoose = require("mongoose");

const WorkspaceSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    workspaceName: { type: String, default: "Main Workspace" },
    workspaces: [{ type: String }],
    operator: {
      name: { type: String, default: "Operator View" },
      email: { type: String, default: "admin@leadops.io" },
      initials: { type: String, default: "AD" }
    },
    workspaceInfo: {
      workspaceId: { type: String, default: "ws_default" },
      plan: { type: String, default: "Professional" },
      teamMembers: { type: Number, default: 1 }
    },
    messaging: {
      whatsappBusinessAccountId: { type: String, default: "" },
      phoneNumberId: { type: String, default: "" },
      accessToken: { type: String, default: "" },
      webhookVerificationToken: { type: String, default: "" },
      templateSyncEnabled: { type: Boolean, default: true }
    },
    automation: {
      defaultWorkflowDelayHours: { type: Number, default: 24 },
      template2DelayMinutes: { type: Number, default: 2 },
      template3DelayMinutes: { type: Number, default: 1 },
      noResponseDelayHours: { type: Number, default: 24 },
      highIntentKeywords: [{ type: String }],
      qualificationThresholdScore: { type: Number, default: 75 },
      autoQualifyLeads: { type: Boolean, default: true },
      sendNotifications: { type: Boolean, default: true }
    },
    infrastructure: {
      mongoUri: { type: String, default: "" },
      redisUrl: { type: String, default: "" },
      environment: { type: String, default: "production" }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("WorkspaceSettings", WorkspaceSettingsSchema);
