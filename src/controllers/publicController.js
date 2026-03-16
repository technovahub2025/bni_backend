const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");
const { logActivity } = require("../services/logService");
const { startWorkflow, resolveTemplateConfig, DEFAULT_TEMPLATE_CONFIG } = require("../services/workflowService");
const { sendTemplateMessage } = require("../services/whatsappService");

function normalizePhone(phone = "") {
  return String(phone).replace(/[^\d+]/g, "");
}

function getSubmittedApplication(lead) {
  const application = lead?.customFields?.application;
  if (!application?.submittedAt) return null;
  return application;
}

async function captureLead(req, res) {
  const name = String(req.body.name || "Unknown").trim() || "Unknown";
  const phone = normalizePhone(req.body.phone);
  const source = String(req.body.source || "visitor_form");
  const autoStart = req.body.autoStart !== false;
  const customFields = req.body.customFields && typeof req.body.customFields === "object" ? req.body.customFields : {};

  if (!phone) return res.status(400).json({ error: "phone is required" });

  let lead = await Lead.findOne({ phone });
  if (!lead) {
    lead = await Lead.create({
      name,
      phone,
      source,
      customFields,
      tags: ["entry_form"]
    });
  } else {
    lead.name = name || lead.name;
    lead.customFields = {
      ...(lead.customFields || {}),
      ...customFields
    };
    await lead.save();
  }

  await logActivity("lead_captured", { source, autoStart }, lead._id);

  let run = null;
  if (autoStart && !lead.optOut) {
    run = await startWorkflow(lead._id);
  }

  res.json({ lead, workflowRun: run, started: !!run });
}

async function getApplicationStatus(req, res) {
  const leadId = String(req.query.leadId || "").trim();
  const phone = normalizePhone(req.query.phone);

  if (!leadId && !phone) {
    return res.json({ submitted: false, lead: null, application: null });
  }

  if (leadId && !mongoose.Types.ObjectId.isValid(leadId)) {
    return res.status(400).json({ error: "leadId is invalid" });
  }

  const lead = await Lead.findOne(leadId ? { _id: leadId } : { phone }).lean();
  if (!lead) {
    return res.json({ submitted: false, lead: null, application: null });
  }

  const application = getSubmittedApplication(lead);

  res.json({
    submitted: !!application,
    lead: {
      _id: lead._id,
      name: lead.name,
      phone: lead.phone
    },
    application: application || null
  });
}

async function submitApplication(req, res) {
  const leadId = String(req.body.leadId || "").trim();
  const phone = normalizePhone(req.body.phone);
  const application = {
    name: String(req.body.name || "").trim(),
    phone,
    email: String(req.body.email || "").trim(),
    city: String(req.body.city || "").trim(),
    notes: String(req.body.notes || "").trim(),
    submittedAt: new Date()
  };

  if (!leadId && !phone) {
    return res.status(400).json({ error: "leadId or phone is required" });
  }
  if (leadId && !mongoose.Types.ObjectId.isValid(leadId)) {
    return res.status(400).json({ error: "leadId is invalid" });
  }

  const lead = await Lead.findOne(leadId ? { _id: leadId } : { phone });
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  lead.name = application.name || lead.name;
  lead.customFields = {
    ...(lead.customFields || {}),
    application: {
      ...((lead.customFields || {}).application || {}),
      ...application
    }
  };
  lead.stage = "conversation";
  await lead.save();

  await logActivity("application_submitted", { email: application.email, city: application.city }, lead._id);

  const latestRun = await WorkflowRun.findOne({ leadId: lead._id }).sort({ createdAt: -1 }).lean();
  const defaultWorkflow = latestRun
    ? null
    : await Workflow.findOne({ name: "default_nurture_workflow" }).lean();
  const templateConfig = latestRun
    ? resolveTemplateConfig(latestRun)
    : defaultWorkflow
      ? resolveTemplateConfig(defaultWorkflow)
      : DEFAULT_TEMPLATE_CONFIG;

  if (templateConfig.applicationSubmittedTemplate) {
    await sendTemplateMessage({
      lead,
      templateName: templateConfig.applicationSubmittedTemplate,
      bodyFallback: "Your application has been received. Our team will contact you soon."
    });
    await logActivity(
      "application_confirmation_sent",
      { templateName: templateConfig.applicationSubmittedTemplate },
      lead._id
    );
  }

  res.json({
    ok: true,
    lead,
    application: lead.customFields?.application || null
  });
}

module.exports = { captureLead, getApplicationStatus, submitApplication };
