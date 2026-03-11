const WorkspaceSettings = require("../models/WorkspaceSettings");
const Workflow = require("../models/Workflow");
const Message = require("../models/Message");
const env = require("../config/env");
const { DEFAULT_TEMPLATE_CONFIG } = require("../services/workflowService");

function normalizeInitials(name, fallback = "AD") {
  const letters = String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
  return letters || fallback;
}

async function ensureWorkspaceSettings() {
  const defaultWorkflow = await Workflow.findOne({ name: "default_nurture_workflow" }).lean();
  const template2DelayMinutes = Math.max(1, Math.round(env.workflowDelayTemplate2Ms / (1000 * 60)) || 2);
  const template3DelayMinutes = Math.max(1, Math.round(env.workflowDelayTemplate3Ms / (1000 * 60)) || 1);
  const noResponseDelayHours =
    Math.max(1, Math.round(env.workflowDelayNoResponseMs / (1000 * 60 * 60)) || 24);

  const defaults = {
    workspaceName: "Main Workspace",
    workspaces: ["Main Workspace", "Development", "Test Environment"],
    operator: {
      name: "Operator View",
      email: "admin@leadops.io",
      initials: "AD"
    },
    workspaceInfo: {
      workspaceId: "ws_1a2b3c4d5e",
      plan: "Professional",
      teamMembers: 1
    },
    messaging: {
      whatsappBusinessAccountId: env.whatsappBusinessAccountId,
      phoneNumberId: env.whatsappPhoneNumberId,
      accessToken: env.whatsappToken,
      webhookVerificationToken: env.whatsappVerifyToken,
      templateSyncEnabled: true
    },
    automation: {
      defaultWorkflowDelayHours: Math.max(1, Math.round(template2DelayMinutes / 60) || 1),
      template2DelayMinutes,
      template3DelayMinutes,
      noResponseDelayHours,
      highIntentKeywords:
        defaultWorkflow?.settings?.replyKeywords ||
        DEFAULT_TEMPLATE_CONFIG.replyKeywords,
      qualificationThresholdScore:
        defaultWorkflow?.settings?.keywordReplyScore || 75,
      autoQualifyLeads: true,
      sendNotifications: true
    },
    infrastructure: {
      mongoUri: env.mongoUri,
      redisUrl: env.redisUrl,
      environment: process.env.NODE_ENV || "production"
    }
  };

  const settings = await WorkspaceSettings.findOneAndUpdate(
    { key: "default" },
    {
      $setOnInsert: {
        key: "default",
        ...defaults
      }
    },
    { upsert: true, new: true }
  );

  return settings;
}

async function getWorkspaceSettings(req, res) {
  const [settings, recentInboxCount] = await Promise.all([
    ensureWorkspaceSettings(),
    Message.countDocuments({ direction: "inbound" })
  ]);

  const operatorName = settings.operator?.name || "Operator View";

  res.json({
    workspaceName: settings.workspaceName,
    workspaces: settings.workspaces?.length ? settings.workspaces : ["Main Workspace"],
    notificationsCount: recentInboxCount,
    operator: {
      name: operatorName,
      email: settings.operator?.email || "admin@leadops.io",
      initials: settings.operator?.initials || normalizeInitials(operatorName)
    },
    messaging: settings.messaging,
    automation: settings.automation,
    infrastructure: settings.infrastructure,
    workspaceInfo: {
      workspaceId: settings.workspaceInfo?.workspaceId || "ws_1a2b3c4d5e",
      plan: settings.workspaceInfo?.plan || "Professional",
      teamMembers: settings.workspaceInfo?.teamMembers || 1,
      createdAt: settings.createdAt
    }
  });
}

async function updateWorkspaceSettings(req, res) {
  const settings = await ensureWorkspaceSettings();
  const updates = {};

  if (req.body.workspaceName !== undefined) {
    updates.workspaceName = String(req.body.workspaceName || "").trim() || settings.workspaceName;
  }

  if (req.body.operator) {
    const name = String(req.body.operator.name || settings.operator?.name || "Operator View").trim();
    const email = String(req.body.operator.email || settings.operator?.email || "admin@leadops.io").trim();
    updates.operator = {
      name,
      email,
      initials: normalizeInitials(name)
    };
  }

  if (req.body.messaging) {
    updates.messaging = {
      ...settings.messaging,
      ...req.body.messaging
    };
  }

  if (req.body.automation) {
    updates.automation = {
      ...settings.automation,
      ...req.body.automation,
      template2DelayMinutes:
        req.body.automation.template2DelayMinutes !== undefined
          ? Math.max(1, Number(req.body.automation.template2DelayMinutes) || 1)
          : settings.automation?.template2DelayMinutes || 2,
      template3DelayMinutes:
        req.body.automation.template3DelayMinutes !== undefined
          ? Math.max(1, Number(req.body.automation.template3DelayMinutes) || 1)
          : settings.automation?.template3DelayMinutes || 1,
      noResponseDelayHours:
        req.body.automation.noResponseDelayHours !== undefined
          ? Math.max(1, Number(req.body.automation.noResponseDelayHours) || 1)
          : settings.automation?.noResponseDelayHours || 24,
      highIntentKeywords: Array.isArray(req.body.automation.highIntentKeywords)
        ? req.body.automation.highIntentKeywords.map((item) => String(item).trim()).filter(Boolean)
        : settings.automation?.highIntentKeywords || []
    };
  }

  if (req.body.infrastructure) {
    updates.infrastructure = {
      ...settings.infrastructure,
      ...req.body.infrastructure
    };
  }

  if (req.body.workspaceInfo) {
    updates.workspaceInfo = {
      ...settings.workspaceInfo,
      ...req.body.workspaceInfo
    };
  }

  const updated = await WorkspaceSettings.findOneAndUpdate(
    { key: "default" },
    { $set: updates },
    { new: true }
  );

  if (updates.automation?.highIntentKeywords) {
    await Workflow.findOneAndUpdate(
      { name: "default_nurture_workflow" },
      {
        $set: {
          "settings.replyKeywords": updates.automation.highIntentKeywords,
          "settings.keywordReplyScore": Number(updated.automation?.qualificationThresholdScore || 75)
        }
      }
    );
  }

  req.body = {};
  return getWorkspaceSettings(req, res);
}

module.exports = {
  getWorkspaceSettings,
  updateWorkspaceSettings
};
