const Lead = require("../models/Lead");
const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");
const ScheduledJob = require("../models/ScheduledJob");
const Message = require("../models/Message");
const WorkspaceSettings = require("../models/WorkspaceSettings");
const Meeting = require("../models/Meeting");
const Notification = require("../models/Notification");
const { workflowQueue, redisQueueEnabled } = require("../queues/workflowQueue");
const { sendTemplateMessage, sendTextMessage } = require("./whatsappService");
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
  meetingTemplate: "meeting_booking_template",
  meetingReminderTemplate: "meeting_reminder_template",
  replyKeywords: ["interested", "yes", "apply"],
  normalReplyScore: 20,
  keywordReplyScore: 50
};

const DEFAULT_REPLY_FLOW_CONFIG = {
  initialTemplate: "",
  initialTemplateVariables: [],
  steps: []
};

const DEFAULT_TEMPLATE_VARIABLE_SOURCE = "lead_name";

const localTimerRefs = new Map();
const POST_WORKFLOW_REPLY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const MEETING_LINK_ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

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
      await processScheduledJob(jobDoc.type, jobDoc.leadId, jobDoc.runId, jobDoc.payload || null);
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

function normalizeReplyFlowConfig(replyFlow = null) {
  const normalizeTemplateVariables = (variables = []) =>
    (Array.isArray(variables) ? variables : []).map((item, index) => ({
      variable: String(item?.variable || `var_${index + 1}`),
      source: [
        "lead_name",
        "application_form_link",
        "zoom_meeting_link",
        "lead_phone",
        "selected_meeting_time"
      ].includes(item?.source)
        ? item.source
        : DEFAULT_TEMPLATE_VARIABLE_SOURCE
    }));

  const steps = Array.isArray(replyFlow?.steps)
    ? replyFlow.steps.map((step, index) => ({
        id: String(step?.id || `step_${index + 1}`),
        triggerType: step?.triggerType === "button_click" ? "button_click" : "user_reply",
        triggerValue: String(step?.triggerValue || "").trim(),
        nextTemplate: String(step?.nextTemplate || "").trim(),
        nextTemplateVariables: normalizeTemplateVariables(step?.nextTemplateVariables),
        followUpDelayValue: Math.max(0, Number(step?.followUpDelayValue) || 0),
        followUpDelayUnit: ["minutes", "hours", "days"].includes(step?.followUpDelayUnit)
          ? step.followUpDelayUnit
          : "minutes",
        followUpMessage: String(step?.followUpMessage || "").trim(),
        finalNoReplyDelayValue: Math.max(0, Number(step?.finalNoReplyDelayValue) || 0),
        finalNoReplyDelayUnit: ["minutes", "hours", "days"].includes(step?.finalNoReplyDelayUnit)
          ? step.finalNoReplyDelayUnit
          : "minutes",
        finalNoReplyMessage: String(step?.finalNoReplyMessage || "").trim()
      }))
    : [];

  return {
    ...DEFAULT_REPLY_FLOW_CONFIG,
    initialTemplate: String(replyFlow?.initialTemplate || "").trim(),
    initialTemplateVariables: normalizeTemplateVariables(replyFlow?.initialTemplateVariables),
    steps
  };
}

function normalizeWorkflow(workflow) {
  return {
    ...workflow,
    type: workflow?.type || "nurture",
    settings: {
      ...DEFAULT_TEMPLATE_CONFIG,
      ...(workflow?.settings || {})
    },
    replyFlow: normalizeReplyFlowConfig(workflow?.replyFlow)
  };
}

function matchesReplyFlowTrigger(step, inboundPayload) {
  const expected = String(step?.triggerValue || "").trim().toLowerCase();
  if (!expected) return false;

  const actualSource =
    step?.triggerType === "button_click"
      ? inboundPayload?.buttonPayload || inboundPayload?.body
      : inboundPayload?.body;

  if (expected === "__flow_reply__") {
    return !!inboundPayload?.isFlowReply && String(actualSource || "").trim().length > 0;
  }

  if (expected === "__any__") {
    return String(actualSource || "").trim().length > 0;
  }

  return String(actualSource || "").trim().toLowerCase() === expected;
}

function findMatchingReplyFlowStep(steps, inboundPayload) {
  return (Array.isArray(steps) ? steps : []).find((step) => matchesReplyFlowTrigger(step, inboundPayload)) || null;
}

function findMeetingSelectionTemplateName(workflow, workflowSettings = {}) {
  const replyFlowSteps = Array.isArray(workflow?.replyFlow?.steps) ? workflow.replyFlow.steps : [];
  const matchedStep = replyFlowSteps.find((step) =>
    /(meeting_schedule|meeting_booking|slot)/i.test(String(step?.nextTemplate || ""))
  );
  if (matchedStep?.nextTemplate) {
    return String(matchedStep.nextTemplate).trim();
  }
  return String(workflowSettings?.meetingTemplate || "").trim();
}

function resolveTemplateVariableValue(source, lead, inboundPayload = null) {
  if (source === "application_form_link") {
    return buildApplicationLink(lead);
  }
  if (source === "zoom_meeting_link") {
    return String(lead?.customFields?.zoomMeetingLink || env.zoomMeetingLink || "").trim();
  }
  if (source === "lead_phone") {
    return String(lead?.phone || "").trim();
  }
  if (source === "selected_meeting_time") {
    return normalizeSelectedMeetingValue(
      inboundPayload?.selectedMeetingTime ||
        inboundPayload?.buttonPayload ||
        inboundPayload?.body ||
        ""
    );
  }
  return String(lead?.name || "").trim();
}

function isMeetingIntentMessage(message = "") {
  return /\b(demo|meeting|call|schedule|slot)\b/i.test(String(message || ""));
}

function isWorkflowStartMessage(message = "") {
  return /\b(hi|hello|hey)\b/i.test(String(message || "").trim());
}

function isTerminalWorkflowTemplate(templateName = "") {
  return /(application_form|membership_application|zoom_link|meeting_link|nexion_zoom_link)/i.test(
    String(templateName || "").trim()
  );
}

function normalizeSelectedMeetingValue(value = "") {
  let normalized = String(value || "").trim();
  if (!normalized) return "";

  normalized = normalized.replace(/(\d+)_([0-1]?\d:\d{2})_([AP]M)$/i, "$2 $3");
  normalized = normalized.replace(/_/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

function parseSelectedMeetingDateTime(value = "") {
  const rawValue = normalizeSelectedMeetingValue(value);
  if (!rawValue) return null;

  const directDate = new Date(rawValue);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const isoDateTimeMatch = rawValue.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s*([AP]M))?$/i);
  if (isoDateTimeMatch) {
    const [, datePart, timePart, meridiem] = isoDateTimeMatch;
    const normalized = `${datePart} ${timePart}${meridiem ? ` ${meridiem.toUpperCase()}` : ""}`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const slashDateTimeMatch = rawValue.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2})(?:\s*([AP]M))?$/i
  );
  if (slashDateTimeMatch) {
    const [, day, month, year, timePart, meridiem] = slashDateTimeMatch;
    const normalized = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${timePart}${meridiem ? ` ${meridiem.toUpperCase()}` : ""}`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

async function createNotification({ type, title, body, leadId = null, meetingId = null }) {
  return Notification.create({
    type,
    title,
    body,
    leadId,
    meetingId
  });
}

async function disableLeadAutoWorkflow(lead, reason, completedTemplate = null) {
  lead.automationState = {
    ...(lead.automationState || {}),
    autoWorkflowDisabled: true,
    stoppedAt: new Date(),
    reason: String(reason || "workflow_stopped").trim(),
    completedTemplate: completedTemplate ? String(completedTemplate).trim() : null
  };
  await lead.save();
}

function isZoomMeetingQuestion(message = "") {
  return /\b(meeting|zoom|link|join|call)\b/i.test(String(message || "").trim());
}

function hasPostWorkflowReplyCooldown(lead) {
  const lastReplyAt = lead?.automationState?.lastPostWorkflowAutoReplyAt;
  if (!lastReplyAt) return false;
  const timestamp = new Date(lastReplyAt).getTime();
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp < POST_WORKFLOW_REPLY_COOLDOWN_MS;
}

async function markPostWorkflowReplySent(lead, type, extra = {}) {
  lead.automationState = {
    ...(lead.automationState || {}),
    ...extra,
    lastPostWorkflowAutoReplyAt: new Date(),
    lastPostWorkflowAutoReplyType: String(type || "manual_auto_reply").trim()
  };
  await lead.save();
}

async function sendPostWorkflowApplicationReply(lead) {
  const body = "If you have filled the application form, our team will contact you soon.";
  await sendTextMessage({ lead, body });
  await markPostWorkflowReplySent(lead, "application_form_follow_up");
  await logActivity("post_workflow_application_reply_sent", { body }, lead._id);
}

async function scheduleZoomLinkAtMeetingTime({ lead, run, meeting, joinUrl }) {
  if (!meeting?.scheduledFor || !joinUrl) return;
  const executeAt = new Date(meeting.scheduledFor).getTime();
  const delayMs = executeAt - Date.now();
  if (delayMs <= 0) return;

  const pendingFor = lead?.automationState?.pendingZoomLinkFor
    ? new Date(lead.automationState.pendingZoomLinkFor).getTime()
    : null;
  if (pendingFor && pendingFor === executeAt) {
    return;
  }

  await scheduleJob({
    leadId: lead._id,
    runId: run?._id || (await WorkflowRun.findOne({ leadId: lead._id }).sort({ createdAt: -1 }).lean())?._id,
    type: "post_workflow_zoom_link",
    delayMs,
    payload: {
      meetingId: String(meeting._id),
      joinUrl
    }
  });

  lead.automationState = {
    ...(lead.automationState || {}),
    pendingZoomLinkFor: new Date(meeting.scheduledFor)
  };
  await lead.save();
  await logActivity(
    "post_workflow_zoom_link_scheduled",
    { meetingId: String(meeting._id), scheduledFor: meeting.scheduledFor, joinUrl },
    lead._id,
    run?._id || null
  );
}

async function handlePostWorkflowLeadReply(lead, inboundPayload) {
  if (!lead?.automationState?.autoWorkflowDisabled) return false;
  if (hasPostWorkflowReplyCooldown(lead)) {
    await logActivity("post_workflow_reply_suppressed_cooldown", {}, lead._id);
    return true;
  }

  const completedTemplate = String(lead?.automationState?.completedTemplate || "").trim();

  if (/application_form|membership_application/i.test(completedTemplate)) {
    await sendPostWorkflowApplicationReply(lead);
    return true;
  }

  if (/zoom_link|meeting_link|nexion_zoom_link/i.test(completedTemplate)) {
    const inboundBody = String(inboundPayload?.body || "").trim();
    if (!isZoomMeetingQuestion(inboundBody)) {
      await logActivity("post_workflow_zoom_reply_skipped_non_meeting_query", { body: inboundBody }, lead._id);
      return true;
    }

    const meeting = await Meeting.findOne({
      leadId: lead._id,
      status: { $in: ["scheduled", "requested"] }
    }).sort({ scheduledFor: -1, createdAt: -1 });

    if (!meeting?.scheduledFor || !meeting?.joinUrl) {
      await createManualFollowUpNotification(lead, inboundPayload);
      return true;
    }

    const scheduledAt = new Date(meeting.scheduledFor).getTime();
    const now = Date.now();
    if (Number.isNaN(scheduledAt)) {
      await createManualFollowUpNotification(lead, inboundPayload);
      return true;
    }

    if (lead?.automationState?.zoomLinkSentAt) {
      const sentAt = new Date(lead.automationState.zoomLinkSentAt).getTime();
      if (!Number.isNaN(sentAt)) {
        await logActivity("post_workflow_zoom_reply_skipped_already_sent", { sentAt }, lead._id);
        return true;
      }
    }

    if (now > scheduledAt + MEETING_LINK_ACTIVE_WINDOW_MS || meeting.status === "completed" || meeting.status === "cancelled") {
      await logActivity("post_workflow_zoom_reply_skipped_meeting_finished", { scheduledFor: meeting.scheduledFor }, lead._id);
      return true;
    }

    if (now >= scheduledAt) {
      const body = `Your Zoom meeting link: ${meeting.joinUrl}`;
      await sendTextMessage({ lead, body });
      await markPostWorkflowReplySent(lead, "zoom_link_follow_up", {
        zoomLinkSentAt: new Date(),
        pendingZoomLinkFor: null
      });
      await logActivity("post_workflow_zoom_link_sent", { meetingId: String(meeting._id), joinUrl: meeting.joinUrl }, lead._id);
      return true;
    }

    const run = await WorkflowRun.findOne({ leadId: lead._id }).sort({ createdAt: -1 });
    await scheduleZoomLinkAtMeetingTime({ lead, run, meeting, joinUrl: meeting.joinUrl });
    return true;
  }

  await createManualFollowUpNotification(lead, inboundPayload);
  return true;
}

async function createManualFollowUpNotification(lead, inboundPayload) {
  const inboundBody = String(inboundPayload?.body || "").trim();
  const title = `Manual follow-up needed for ${lead.name || lead.phone}`;
  const body = inboundBody
    ? `Workflow is closed for this lead. Latest message: ${inboundBody}`
    : "Workflow is closed for this lead. Review and reply manually.";

  await createNotification({
    type: "manual_follow_up_required",
    title,
    body,
    leadId: lead._id
  });
  await logActivity(
    "manual_follow_up_required",
    {
      body: inboundBody,
      reason: lead?.automationState?.reason || "workflow_closed",
      completedTemplate: lead?.automationState?.completedTemplate || null
    },
    lead._id
  );
}

async function applyLeadScoring(lead, run, inboundBody, workflowSettings) {
  const scoring = calculateScore(inboundBody, workflowSettings);
  if (!scoring.total && !(Array.isArray(scoring.breakdown) && scoring.breakdown.length)) {
    return scoring;
  }

  lead.score += scoring.total;
  lead.scoreBreakdown = [
    ...(lead.scoreBreakdown || []),
    ...scoring.breakdown.map((item) => ({ ...item, message: inboundBody, createdAt: new Date() }))
  ];
  await lead.save();
  await logActivity("lead_scored", scoring, lead._id, run?._id || null);
  return scoring;
}

async function createMeetingOutcome({ lead, run, inboundPayload, workflowSettings }) {
  const selectedMeetingTime = String(inboundPayload?.selectedMeetingTime || "").trim();
  const joinUrl = String(lead?.customFields?.zoomMeetingLink || env.zoomMeetingLink || "").trim();
  const scheduledFor = parseSelectedMeetingDateTime(selectedMeetingTime);
  const hasValidScheduledFor = scheduledFor && !Number.isNaN(scheduledFor.getTime());
  const status = hasValidScheduledFor ? "scheduled" : "requested";

  const existingMeeting = await Meeting.findOne({
    leadId: lead._id,
    status: { $in: ["requested", "scheduled"] }
  }).sort({ createdAt: -1 });

  const meeting =
    existingMeeting ||
    (await Meeting.create({
      leadId: lead._id,
      title: "Sales Discovery Meeting",
      status,
      channel: "zoom",
      scheduledFor: hasValidScheduledFor ? scheduledFor : null,
      joinUrl,
      notes: inboundPayload?.body || "",
      source: "automation"
    }));

  if (existingMeeting) {
    existingMeeting.status = status;
    existingMeeting.scheduledFor = hasValidScheduledFor ? scheduledFor : existingMeeting.scheduledFor;
    existingMeeting.joinUrl = joinUrl || existingMeeting.joinUrl;
    existingMeeting.notes = inboundPayload?.body || existingMeeting.notes;
    await existingMeeting.save();
  }

  lead.stage = hasValidScheduledFor ? "meeting_scheduled" : "meeting_requested";
  await lead.save();

  await createNotification({
    type: hasValidScheduledFor ? "meeting_scheduled" : "meeting_requested",
    title: hasValidScheduledFor ? `Meeting scheduled for ${lead.name}` : `Meeting requested by ${lead.name}`,
    body: hasValidScheduledFor
      ? `${selectedMeetingTime}${joinUrl ? ` • ${joinUrl}` : ""}`
      : inboundPayload?.body || "Lead asked for a demo or call.",
    leadId: lead._id,
    meetingId: meeting._id
  });

  await logActivity(
    hasValidScheduledFor ? "meeting_scheduled" : "meeting_requested",
    {
      meetingId: String(meeting._id),
      selectedMeetingTime,
      joinUrl
    },
    lead._id,
    run?._id || null
  );

  if (hasValidScheduledFor && workflowSettings?.meetingTemplate) {
    await sendTemplateMessage({
      lead,
      templateName: workflowSettings.meetingTemplate,
      bodyFallback: joinUrl
        ? `Your meeting is booked. Join here: ${joinUrl}`
        : `Your meeting request is confirmed for ${selectedMeetingTime}`,
      templateParams: [selectedMeetingTime || "To be confirmed", joinUrl || env.appBaseUrl]
    });
  }

  return meeting;
}

async function promptForMeetingDateTime({ lead, run, workflow, workflowSettings }) {
  const meetingSelectionTemplate = findMeetingSelectionTemplateName(workflow, workflowSettings);
  const warningMessage =
    "Please select both date and time to continue. Once you choose them, we will confirm your meeting.";

  await sendTextMessage({
    lead,
    body: warningMessage
  });

  if (meetingSelectionTemplate) {
    await sendTemplateMessage({
      lead,
      templateName: meetingSelectionTemplate,
      bodyFallback: "Please select a date and time slot."
    });
  }

  await logActivity(
    "meeting_date_time_missing_reprompted",
    {
      warningMessage,
      templateName: meetingSelectionTemplate || null
    },
    lead._id,
    run?._id || null
  );
}

function resolveTemplateParams(bindings, lead, inboundPayload = null) {
  return (Array.isArray(bindings) ? bindings : []).map((binding) =>
    resolveTemplateVariableValue(binding?.source, lead, inboundPayload)
  );
}

function resolveReplyFlowTemplateParams(templateName, bindings, lead, inboundPayload = null) {
  const normalizedTemplateName = String(templateName || "").trim().toLowerCase();
  const normalizedBindings = Array.isArray(bindings) ? bindings : [];
  const isApplicationLinkTemplate =
    normalizedTemplateName === "membership_application_template" ||
    normalizedTemplateName.includes("application_form") ||
    (normalizedTemplateName.includes("application") && normalizedTemplateName.includes("link"));

  if (isApplicationLinkTemplate && normalizedBindings.length === 0) {
    return [resolveTemplateVariableValue("application_form_link", lead, inboundPayload)];
  }

  if (
    isApplicationLinkTemplate &&
    normalizedBindings.length === 1 &&
    normalizedBindings[0]?.source === "lead_name"
  ) {
    return [resolveTemplateVariableValue("application_form_link", lead, inboundPayload)];
  }

  return resolveTemplateParams(normalizedBindings, lead, inboundPayload);
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

async function scheduleJob({ leadId, runId, type, delayMs, payload = null }) {
  const scheduleLocalFallback = async (reason = "redis_disabled") => {
    const localJobId = `local-${type}-${runId}-${Date.now()}`;
    const localJob = await ScheduledJob.create({
      leadId,
      runId,
      executeAt: new Date(Date.now() + delayMs),
      type,
      bullJobId: localJobId,
      payload
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
      { leadId: String(leadId), runId: String(runId), type, payload },
      { delay: delayMs, jobId: bullJobId, removeOnComplete: true, removeOnFail: false }
    );
    await ScheduledJob.create({
      leadId,
      runId,
      executeAt: new Date(Date.now() + delayMs),
      type,
      bullJobId: job.id,
      payload
    });
    await logActivity("job_scheduled", { type, jobId: job.id }, leadId, runId);
  } catch (error) {
    await scheduleLocalFallback(`redis_add_failed:${error.code || error.message}`);
  }
}

async function scheduleReplyFlowFollowUps({ lead, run, step, stepIndex }) {
  const followUpDelayMs = toDelayMs(step?.followUpDelayValue, step?.followUpDelayUnit);
  const followUpMessage = String(step?.followUpMessage || "").trim();
  const finalNoReplyDelayMs = toDelayMs(step?.finalNoReplyDelayValue, step?.finalNoReplyDelayUnit);
  const finalNoReplyMessage = String(step?.finalNoReplyMessage || "").trim();

  if (followUpDelayMs && followUpMessage) {
    await scheduleJob({
      leadId: lead._id,
      runId: run._id,
      type: "reply_flow_follow_up",
      delayMs: followUpDelayMs,
      payload: {
        phase: "follow_up",
        expectedStepIndex: stepIndex,
        stepId: step?.id || null,
        sentAt: new Date().toISOString(),
        followUpMessage,
        finalNoReplyDelayValue: Math.max(0, Number(step?.finalNoReplyDelayValue) || 0),
        finalNoReplyDelayUnit: ["minutes", "hours", "days"].includes(step?.finalNoReplyDelayUnit)
          ? step.finalNoReplyDelayUnit
          : "minutes",
        finalNoReplyMessage
      }
    });
    return;
  }

  if (finalNoReplyDelayMs && finalNoReplyMessage) {
    await scheduleJob({
      leadId: lead._id,
      runId: run._id,
      type: "reply_flow_follow_up",
      delayMs: finalNoReplyDelayMs,
      payload: {
        phase: "final_no_reply",
        expectedStepIndex: stepIndex,
        stepId: step?.id || null,
        sentAt: new Date().toISOString(),
        finalNoReplyMessage
      }
    });
  }
}

async function hasInboundReplySince(leadId, sentAt) {
  const since = new Date(sentAt);
  if (Number.isNaN(since.getTime())) return false;
  return Message.exists({
    leadId,
    direction: "inbound",
    createdAt: { $gte: since }
  });
}

async function initializeLocalScheduler() {
  const pendingJobs = await ScheduledJob.find({ bullJobId: /^local-/ }).lean();
  pendingJobs.forEach((job) => scheduleLocalTimer(job));
}

async function startWorkflow(leadId, workflowId = null, options = {}) {
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

  const workflow = workflowId
    ? await Workflow.findById(workflowId)
    : await ensureDefaultWorkflow();
  if (!workflow) {
    const error = new Error("Workflow not found");
    error.status = 404;
    throw error;
  }
  if (!workflow.active) {
    const error = new Error("Workflow is inactive");
    error.status = 400;
    throw error;
  }

  const normalizedWorkflow = normalizeWorkflow(workflow.toObject ? workflow.toObject() : workflow);

  if (normalizedWorkflow.type === "reply_flow") {
    if (!normalizedWorkflow.replyFlow.initialTemplate) {
      const error = new Error("Reply workflow initial template is required");
      error.status = 400;
      throw error;
    }

    const run = await WorkflowRun.create({
      workflowId: workflow._id,
      leadId,
      currentStep: "awaiting_initial_reply",
      currentStepIndex: -1,
      state: "running"
    });

    lead.status = "nurturing";
    await lead.save();

    if (!options.deferInitialReplyFlowSend) {
      await sendInitialReplyFlowTemplate({ lead, workflow: normalizedWorkflow, run });
    }

    await logActivity(
      "reply_workflow_started",
      {
        workflowId: String(workflow._id),
        templateName: normalizedWorkflow.replyFlow.initialTemplate,
        mode: options.deferInitialReplyFlowSend ? "send_initial_on_inbound_message" : "send_initial_immediately"
      },
      leadId,
      run._id
    );
    return run;
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

async function findAutoReplyWorkflow() {
  const workflow = await Workflow.findOne({ type: "reply_flow", active: true })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  return workflow ? normalizeWorkflow(workflow) : null;
}

async function resolveInboundWorkflowRun(lead, inboundPayload = null) {
  const runningRuns = await WorkflowRun.find({ leadId: lead._id, state: "running" }).sort({ createdAt: -1 });
  const activeRun = runningRuns[0] || null;
  const autoReplyWorkflow = await findAutoReplyWorkflow();
  const inboundBody = String(inboundPayload?.body || "").trim();

  if (runningRuns.length > 1) {
    await Promise.all(
      runningRuns.slice(1).map((run) => markRunStopped(run, "duplicate_running_run_cleanup"))
    );
  }

  if (activeRun) {
    const activeWorkflow = await Workflow.findById(activeRun.workflowId).lean();
    const normalizedActiveWorkflow = activeWorkflow ? normalizeWorkflow(activeWorkflow) : null;

    if (normalizedActiveWorkflow?.type === "reply_flow") {
      return activeRun;
    }

    if (normalizedActiveWorkflow?.type === "nurture" && autoReplyWorkflow) {
      await markRunStopped(activeRun, "switched_to_reply_workflow");
      const replyRun = await startWorkflow(lead._id, String(autoReplyWorkflow._id), {
        deferInitialReplyFlowSend: true
      });
      await logActivity(
        "reply_workflow_took_over_inbound",
        { previousWorkflowId: String(activeRun.workflowId), workflowId: String(autoReplyWorkflow._id) },
        lead._id,
        replyRun._id
      );
      return replyRun;
    }

    return activeRun;
  }

  if (lead?.automationState?.autoWorkflowDisabled) {
    return null;
  }

  if (!isWorkflowStartMessage(inboundBody)) {
    return null;
  }

  if (autoReplyWorkflow) {
    const replyRun = await startWorkflow(lead._id, String(autoReplyWorkflow._id), {
      deferInitialReplyFlowSend: true
    });
    await logActivity(
      "reply_workflow_auto_started_on_inbound",
      { workflowId: String(autoReplyWorkflow._id) },
      lead._id,
      replyRun._id
    );
    return replyRun;
  }

  const nurtureRun = await startWorkflow(lead._id);
  await logActivity("nurture_workflow_auto_started_on_hi", {}, lead._id, nurtureRun._id);
  return nurtureRun;
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
  const applicationLink = buildApplicationLink(lead);
  const templates = resolveTemplateConfig(run);
  lead.status = "qualified";
  if (!["meeting_requested", "meeting_scheduled"].includes(String(lead.stage || ""))) {
    lead.stage = "application";
  }
  await disableLeadAutoWorkflow(lead, "application_form_template_sent", templates.membershipTemplate);
  if (templates.membershipTemplate) {
    await sendTemplateMessage({
      lead,
      templateName: templates.membershipTemplate,
      bodyFallback: `Apply here: ${applicationLink}`,
      templateParams: [applicationLink]
    });
    await logActivity(
      "membership_application_sent",
      { templateName: templates.membershipTemplate, applicationLink },
      lead._id,
      run._id
    );
  }
  await logActivity("meeting_reminder_hook", { leadStage: "application", applicationLink }, lead._id, run._id);
  await markRunCompleted(run, "lead_qualified");
}

async function disqualifyLead(lead, run, reason = "score_below_threshold") {
  lead.status = "unqualified";
  await lead.save();
  await markRunStopped(run, reason);
}

async function sendInitialReplyFlowTemplate({ lead, workflow, run }) {
  await sendTemplateMessage({
    lead,
    templateName: workflow.replyFlow.initialTemplate,
    bodyFallback: "Hello from workflow",
      templateParams: resolveReplyFlowTemplateParams(
        workflow.replyFlow.initialTemplate,
        workflow.replyFlow.initialTemplateVariables,
        lead,
        null
      )
  });

  run.currentStepIndex = 0;
  run.currentStep = "awaiting_reply_selection";
  await run.save();

  await logActivity(
    "reply_workflow_initial_template_sent",
    {
      workflowId: String(workflow._id),
      templateName: workflow.replyFlow.initialTemplate
    },
    lead._id,
    run._id
  );
}

async function handleInboundReply(lead, inboundPayload) {
  if (await handlePostWorkflowLeadReply(lead, inboundPayload)) {
    return;
  }

  const run = await resolveInboundWorkflowRun(lead, inboundPayload);
  if (!run) {
    if (lead?.automationState?.autoWorkflowDisabled) {
      await createManualFollowUpNotification(lead, inboundPayload);
    }
    return;
  }

  const workflow = await Workflow.findById(run.workflowId).lean();
  if (!workflow) return;

  const normalizedWorkflow = normalizeWorkflow(workflow);

  if (normalizedWorkflow.type === "reply_flow") {
    const inboundBody = inboundPayload?.body || "";
    const workflowSettings = resolveTemplateConfig(run);
    await cancelPendingJobs(run._id);

    await applyLeadScoring(lead, run, inboundBody, workflowSettings);

    if (/\bstop\b/i.test(inboundBody)) {
      lead.optOut = true;
      lead.status = "unqualified";
      await lead.save();
      await markRunStopped(run, "stop_keyword");
      return;
    }

    if (run.currentStepIndex < 0) {
      await sendInitialReplyFlowTemplate({ lead, workflow: normalizedWorkflow, run });
      return;
    }

    const step = findMatchingReplyFlowStep(
      normalizedWorkflow.replyFlow.steps.slice(Math.max(0, run.currentStepIndex)),
      inboundPayload
    );
    if (!step) {
      if (isMeetingIntentMessage(inboundBody)) {
        await createMeetingOutcome({ lead, run, inboundPayload, workflowSettings });
      }
      await sendInitialReplyFlowTemplate({ lead, workflow: normalizedWorkflow, run });
      await logActivity(
        "reply_workflow_reprompted",
        {
          workflowId: String(workflow._id),
          reason: "no_matching_step",
          inboundBody
        },
        lead._id,
        run._id
      );
      return;
    }

    const matchedStepIndex = normalizedWorkflow.replyFlow.steps.findIndex((item) => item.id === step.id);

    const isMeetingFlowReply = inboundPayload?.isFlowReply && step?.triggerValue === "__flow_reply__";
    const parsedMeetingDateTime = isMeetingFlowReply
      ? parseSelectedMeetingDateTime(inboundPayload?.selectedMeetingTime)
      : null;

    if (isMeetingFlowReply && !parsedMeetingDateTime) {
      await promptForMeetingDateTime({
        lead,
        run,
        workflow: normalizedWorkflow,
        workflowSettings
      });
      return;
    }

    if (isMeetingFlowReply) {
      await createMeetingOutcome({ lead, run, inboundPayload, workflowSettings });
    }

    await sendTemplateMessage({
      lead,
      templateName: step.nextTemplate,
      bodyFallback: "Workflow reply step",
      templateParams: resolveReplyFlowTemplateParams(
        step.nextTemplate,
        step.nextTemplateVariables,
        lead,
        inboundPayload
      )
    });

    run.currentStepIndex = matchedStepIndex + 1;
    run.currentStep = `reply_step_${run.currentStepIndex}`;
    await run.save();

    if (isTerminalWorkflowTemplate(step.nextTemplate)) {
      await disableLeadAutoWorkflow(lead, "terminal_template_sent", step.nextTemplate);
    }

    await scheduleReplyFlowFollowUps({
      lead,
      run,
      step,
      stepIndex: run.currentStepIndex
    });

    await logActivity(
      "reply_workflow_step_advanced",
      {
        workflowId: String(workflow._id),
        triggerType: step.triggerType,
        triggerValue: step.triggerValue,
        nextTemplate: step.nextTemplate,
        nextStepIndex: run.currentStepIndex
      },
      lead._id,
      run._id
    );

    if (run.currentStepIndex >= normalizedWorkflow.replyFlow.steps.length) {
      await markRunCompleted(run, "reply_workflow_completed");
      return;
    }

    if (isTerminalWorkflowTemplate(step.nextTemplate)) {
      await markRunCompleted(run, "reply_workflow_terminal_template_sent");
    }

    return;
  }

  const inboundBody = inboundPayload?.body || "";
  const workflowSettings = resolveTemplateConfig(run);

  await cancelPendingJobs(run._id);
  await logActivity("reply_received_interrupt", { inboundBody }, lead._id, run._id);

  await applyLeadScoring(lead, run, inboundBody, workflowSettings);

  if (/\bstop\b/i.test(inboundBody)) {
    lead.optOut = true;
    lead.status = "unqualified";
    await lead.save();
    await markRunStopped(run, "stop_keyword");
    return;
  }
  if (isMeetingIntentMessage(inboundBody)) {
    await createMeetingOutcome({ lead, run, inboundPayload, workflowSettings });
  }
  await qualifyLead(lead, run);
}

async function processScheduledJob(type, leadId, runId, payload = null) {
  const [lead, run] = await Promise.all([Lead.findById(leadId), WorkflowRun.findById(runId)]);
  if (!lead || lead.optOut) return;

  if (type === "post_workflow_zoom_link") {
    const meeting = payload?.meetingId ? await Meeting.findById(payload.meetingId) : null;
    const joinUrl = String(payload?.joinUrl || meeting?.joinUrl || "").trim();
    if (!meeting || !joinUrl) return;

    if (lead?.automationState?.zoomLinkSentAt) return;

    const scheduledAt = meeting.scheduledFor ? new Date(meeting.scheduledFor).getTime() : NaN;
    if (Number.isNaN(scheduledAt) || Date.now() > scheduledAt + MEETING_LINK_ACTIVE_WINDOW_MS) {
      return;
    }

    const body = `Your Zoom meeting link: ${joinUrl}`;
    await sendTextMessage({ lead, body });
    await markPostWorkflowReplySent(lead, "zoom_link_scheduled_send", {
      zoomLinkSentAt: new Date(),
      pendingZoomLinkFor: null
    });
    await logActivity(
      "post_workflow_zoom_link_sent",
      { meetingId: String(meeting._id), joinUrl, mode: "scheduled" },
      lead._id,
      run?._id || null
    );
    return;
  }

  if (!run || run.state !== "running") return;

  if (type === "reply_flow_follow_up") {
    const followUpPayload = payload && typeof payload === "object" ? payload : {};
    const expectedStepIndex = Number(followUpPayload.expectedStepIndex);
    const sentAt = String(followUpPayload.sentAt || "").trim();
    const phase = String(followUpPayload.phase || "follow_up").trim();
    const hasReply = sentAt ? await hasInboundReplySince(lead._id, sentAt) : false;

    if (hasReply || !Number.isFinite(expectedStepIndex) || run.currentStepIndex !== expectedStepIndex) {
      return;
    }

    if (phase === "follow_up") {
      const followUpMessage = String(followUpPayload.followUpMessage || "").trim();
      if (!followUpMessage) return;

      await sendTextMessage({
        lead,
        body: followUpMessage
      });
      await logActivity(
        "reply_flow_follow_up_sent",
        {
          stepId: followUpPayload.stepId || null,
          expectedStepIndex,
          message: followUpMessage
        },
        lead._id,
        run._id
      );

      const finalNoReplyDelayMs = toDelayMs(
        followUpPayload.finalNoReplyDelayValue,
        followUpPayload.finalNoReplyDelayUnit
      );
      const finalNoReplyMessage = String(followUpPayload.finalNoReplyMessage || "").trim();
      if (finalNoReplyDelayMs && finalNoReplyMessage) {
        await scheduleJob({
          leadId: lead._id,
          runId: run._id,
          type: "reply_flow_follow_up",
          delayMs: finalNoReplyDelayMs,
          payload: {
            ...followUpPayload,
            phase: "final_no_reply",
            sentAt: sentAt || new Date().toISOString()
          }
        });
      }
      return;
    }

    const finalNoReplyMessage = String(followUpPayload.finalNoReplyMessage || "").trim();
    if (!finalNoReplyMessage) return;

    await sendTextMessage({
      lead,
      body: finalNoReplyMessage
    });
    lead.status = "no_response";
    await lead.save();
    await logActivity(
      "reply_flow_no_response_sent",
      {
        stepId: followUpPayload.stepId || null,
        expectedStepIndex,
        message: finalNoReplyMessage
      },
      lead._id,
      run._id
    );
    await markRunCompleted(run, "reply_flow_no_response");
    return;
  }

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
  const runs = await WorkflowRun.find({ leadId, state: "running" }).sort({ createdAt: -1 });
  if (!runs.length) return null;
  await Promise.all(runs.map((run) => markRunStopped(run, reason)));
  return runs[0];
}

async function deleteWorkflow(workflowId) {
  const workflow = await Workflow.findById(workflowId);
  if (!workflow) {
    const error = new Error("Workflow not found");
    error.status = 404;
    throw error;
  }

  const runs = await WorkflowRun.find({ workflowId });
  await Promise.all(
    runs.map(async (run) => {
      await cancelPendingJobs(run._id);
    })
  );

  await WorkflowRun.deleteMany({ workflowId });
  await Workflow.deleteOne({ _id: workflowId });

  return workflow;
}

module.exports = {
  ensureDefaultWorkflow,
  initializeLocalScheduler,
  startWorkflow,
  findAutoReplyWorkflow,
  resolveInboundWorkflowRun,
  processScheduledJob,
  handleInboundReply,
  cancelPendingJobs,
  stopWorkflowForLead,
  deleteWorkflow,
  DEFAULT_TEMPLATE_CONFIG,
  DEFAULT_REPLY_FLOW_CONFIG,
  resolveTemplateConfig,
  normalizeReplyFlowConfig,
  normalizeWorkflow,
  resolveTemplateParams
};
