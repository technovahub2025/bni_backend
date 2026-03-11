const Lead = require("../models/Lead");
const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");
const ScheduledJob = require("../models/ScheduledJob");
const Message = require("../models/Message");
const WorkspaceSettings = require("../models/WorkspaceSettings");
const { workflowQueue, redisQueueEnabled } = require("../queues/workflowQueue");
const { sendTemplateMessage } = require("./whatsappService");
const { calculateScore } = require("./leadScoring");
const { logActivity } = require("./logService");
const env = require("../config/env");

const DEFAULT_TEMPLATE_CONFIG = {
  template1: "template_1",
  template2: "template_2",
  template3: "template_3",
  template2DelayValue: 24,
  template2DelayUnit: "hours",
  template3DelayValue: 48,
  template3DelayUnit: "hours",
  membershipTemplate: "membership_application_template",
  applicationSubmittedTemplate: "whatsapp_automation_request_info",
  replyKeywords: ["interested", "yes", "apply"],
  normalReplyScore: 20,
  keywordReplyScore: 50
};

const localTimerRefs = new Map();

function toDelayMs(value, unit) {
  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) return null;

  if (unit === "minutes") return normalizedValue * 60 * 1000;
  if (unit === "days") return normalizedValue * 24 * 60 * 60 * 1000;
  return normalizedValue * 60 * 60 * 1000;
}

async function getWorkflowDelays(workflowSettings = null) {
  const settings = await WorkspaceSettings.findOne({ key: "default" }).lean();
  const template2DelayMinutes = Number(settings?.automation?.template2DelayMinutes);
  const template3DelayMinutes = Number(settings?.automation?.template3DelayMinutes);
  const noResponseDelayHours = Number(settings?.automation?.noResponseDelayHours);
  const configuredTemplate2Delay =
    toDelayMs(workflowSettings?.template2DelayValue, workflowSettings?.template2DelayUnit) ||
    (Number.isFinite(template2DelayMinutes) && template2DelayMinutes > 0
      ? template2DelayMinutes * 60 * 1000
      : env.workflowDelayTemplate2Ms);
  const configuredTemplate3Delay =
    toDelayMs(workflowSettings?.template3DelayValue, workflowSettings?.template3DelayUnit) ||
    (Number.isFinite(template3DelayMinutes) && template3DelayMinutes > 0
      ? template3DelayMinutes * 60 * 1000
      : env.workflowDelayTemplate3Ms);

  return {
    send_template_2: configuredTemplate2Delay,
    send_template_3: configuredTemplate3Delay,
    mark_no_response:
      Number.isFinite(noResponseDelayHours) && noResponseDelayHours > 0
        ? noResponseDelayHours * 60 * 60 * 1000
        : env.workflowDelayNoResponseMs
  };
}

function clearLocalTimer(jobId) {
  const key = String(jobId);
  const timer = localTimerRefs.get(key);
  if (timer) {
    clearTimeout(timer);
    localTimerRefs.delete(key);
  }
}

function scheduleLocalTimer(jobDoc) {
  const delayMs = Math.max(0, new Date(jobDoc.executeAt).getTime() - Date.now());
  const key = String(jobDoc.bullJobId);
  clearLocalTimer(key);

  const timer = setTimeout(async () => {
    localTimerRefs.delete(key);
    try {
      await processScheduledJob(jobDoc.type, jobDoc.leadId, jobDoc.runId);
    } finally {
      await ScheduledJob.deleteOne({ _id: jobDoc._id });
    }
  }, delayMs);

  localTimerRefs.set(key, timer);
}

async function ensureDefaultWorkflow() {
  return Workflow.findOneAndUpdate(
    { name: "default_nurture_workflow" },
    {
      $setOnInsert: {
        name: "default_nurture_workflow",
        active: true,
        settings: DEFAULT_TEMPLATE_CONFIG
      }
    },
    { upsert: true, new: true }
  );
}

function resolveTemplateConfig(workflowOrRun) {
  return {
    ...DEFAULT_TEMPLATE_CONFIG,
    ...(workflowOrRun?.settings || {}),
    ...(workflowOrRun?.templateConfig || {})
  };
}

async function cancelPendingJobs(runId) {
  const jobs = await ScheduledJob.find({ runId });
  await Promise.all(
    jobs.map(async (job) => {
      clearLocalTimer(job.bullJobId);
      try {
        await workflowQueue.remove(job.bullJobId);
      } catch (error) {
        // BullMQ remove may fail if already consumed
      }
    })
  );
  await ScheduledJob.deleteMany({ runId });
}

async function scheduleJob({ leadId, runId, type, delayMs }) {
  const scheduleLocalFallback = async (reason = "redis_disabled") => {
    const localJobId = `local-${type}-${runId}-${Date.now()}`;
    const localJob = await ScheduledJob.create({
      leadId,
      runId,
      executeAt: new Date(Date.now() + delayMs),
      type,
      bullJobId: localJobId
    });
    scheduleLocalTimer(localJob);
    await logActivity("job_scheduled_local", { type, jobId: localJobId, reason }, leadId, runId);
  };

  if (!redisQueueEnabled) {
    await scheduleLocalFallback("redis_disabled");
    return;
  }

  try {
    const bullJobId = `${type}-${runId}-${Date.now()}`;
    const job = await workflowQueue.add(
      type,
      { leadId: String(leadId), runId: String(runId), type },
      { delay: delayMs, jobId: bullJobId, removeOnComplete: true, removeOnFail: false }
    );
    await ScheduledJob.create({
      leadId,
      runId,
      executeAt: new Date(Date.now() + delayMs),
      type,
      bullJobId: job.id
    });
    await logActivity("job_scheduled", { type, jobId: job.id }, leadId, runId);
  } catch (error) {
    await scheduleLocalFallback(`redis_add_failed:${error.code || error.message}`);
  }
}

async function initializeLocalScheduler() {
  const pendingJobs = await ScheduledJob.find({ bullJobId: /^local-/ }).lean();
  pendingJobs.forEach((job) => scheduleLocalTimer(job));
}

async function startWorkflow(leadId) {
  const lead = await Lead.findById(leadId);
  if (!lead) {
    const error = new Error("Lead not found");
    error.status = 404;
    throw error;
  }
  if (lead.optOut) {
    const error = new Error("Lead opted out");
    error.status = 400;
    throw error;
  }

  const activeRun = await WorkflowRun.findOne({ leadId, state: "running" });
  if (activeRun) return activeRun;

  const workflow = await ensureDefaultWorkflow();
  if (!workflow.active) {
    const error = new Error("Workflow is inactive");
    error.status = 400;
    throw error;
  }
  const run = await WorkflowRun.create({
    workflowId: workflow._id,
    leadId,
    currentStep: "template_1",
    templateConfig: resolveTemplateConfig(workflow),
    state: "running"
  });

  lead.status = "nurturing";
  await lead.save();

  await sendTemplateMessage({
    lead,
    templateName: run.templateConfig.template1,
    bodyFallback: "Hello from template 1"
  });
  const delays = await getWorkflowDelays(run.templateConfig);
  await scheduleJob({ leadId, runId: run._id, type: "send_template_2", delayMs: delays.send_template_2 });
  await logActivity("workflow_started", { step: "template_1" }, leadId, run._id);
  return run;
}

async function markRunStopped(run, reason) {
  run.state = "stopped";
  await run.save();
  await cancelPendingJobs(run._id);
  await logActivity("workflow_stopped", { reason }, run.leadId, run._id);
}

async function markRunCompleted(run, reason) {
  run.state = "completed";
  await run.save();
  await cancelPendingJobs(run._id);
  await logActivity("workflow_completed", { reason }, run.leadId, run._id);
}

function buildApplicationLink(lead) {
  const baseUrl = env.membershipLink || `${env.appBaseUrl}/apply`;
  const url = new URL(baseUrl);
  url.searchParams.set("leadId", String(lead._id));
  if (lead.phone) {
    url.searchParams.set("phone", String(lead.phone));
  }
  if (lead.name) {
    url.searchParams.set("name", String(lead.name));
  }
  return url.toString();
}

async function qualifyLead(lead, run) {
  const templates = resolveTemplateConfig(run);
  const applicationLink = buildApplicationLink(lead);
  lead.status = "qualified";
  lead.stage = "application";
  await lead.save();
  await logActivity("meeting_reminder_hook", { leadStage: "application", applicationLink }, lead._id, run._id);
  await sendTemplateMessage({
    lead,
    templateName: templates.membershipTemplate,
    bodyFallback: `Apply here: ${applicationLink}`,
    templateParams: [applicationLink]
  });
  await markRunCompleted(run, "lead_qualified");
}

async function disqualifyLead(lead, run, reason = "score_below_threshold") {
  lead.status = "unqualified";
  await lead.save();
  await markRunStopped(run, reason);
}

async function handleInboundReply(lead, inboundBody) {
  const run = await WorkflowRun.findOne({ leadId: lead._id, state: "running" }).sort({ createdAt: -1 });
  if (!run) return;
  const workflowSettings = resolveTemplateConfig(run);

  await cancelPendingJobs(run._id);
  await logActivity("reply_received_interrupt", { inboundBody }, lead._id, run._id);

  const scoring = calculateScore(inboundBody, workflowSettings);
  lead.score += scoring.total;
  lead.scoreBreakdown = [
    ...(lead.scoreBreakdown || []),
    ...scoring.breakdown.map((item) => ({ ...item, message: inboundBody, createdAt: new Date() }))
  ];
  await lead.save();
  await logActivity("lead_scored", scoring, lead._id, run._id);

  if (/\bstop\b/i.test(inboundBody)) {
    lead.optOut = true;
    lead.status = "unqualified";
    await lead.save();
    await markRunStopped(run, "stop_keyword");
    return;
  }
  await qualifyLead(lead, run);
}

async function processScheduledJob(type, leadId, runId) {
  const [lead, run] = await Promise.all([Lead.findById(leadId), WorkflowRun.findById(runId)]);
  if (!lead || !run || run.state !== "running" || lead.optOut) return;
  const templates = resolveTemplateConfig(run);
  const delays = await getWorkflowDelays(templates);

  const hasInboundReply = await Message.exists({
    leadId: lead._id,
    direction: "inbound",
    createdAt: { $gte: run.createdAt }
  });
  if (hasInboundReply) return;

  if (type === "send_template_2") {
    run.currentStep = "template_2";
    await run.save();
    await logActivity("retargeting_hook", { channel: "ads", trigger: "no_reply_after_template_1" }, lead._id, run._id);
    await sendTemplateMessage({
      lead,
      templateName: templates.template2,
      bodyFallback: "Follow-up template 2"
    });
    await scheduleJob({ leadId: lead._id, runId: run._id, type: "send_template_3", delayMs: delays.send_template_3 });
    return;
  }

  if (type === "send_template_3") {
    run.currentStep = "template_3";
    await run.save();
    await sendTemplateMessage({
      lead,
      templateName: templates.template3,
      bodyFallback: "Last follow-up template 3"
    });
    await scheduleJob({
      leadId: lead._id,
      runId: run._id,
      type: "mark_no_response",
      delayMs: delays.mark_no_response
    });
    return;
  }

  if (type === "mark_no_response") {
    lead.status = "no_response";
    await lead.save();
    await markRunCompleted(run, "no_response_after_3_attempts");
  }
}

async function stopWorkflowForLead(leadId, reason = "manual_stop") {
  const run = await WorkflowRun.findOne({ leadId, state: "running" }).sort({ createdAt: -1 });
  if (!run) return null;
  await markRunStopped(run, reason);
  return run;
}

module.exports = {
  ensureDefaultWorkflow,
  initializeLocalScheduler,
  startWorkflow,
  processScheduledJob,
  handleInboundReply,
  cancelPendingJobs,
  stopWorkflowForLead,
  DEFAULT_TEMPLATE_CONFIG
};
