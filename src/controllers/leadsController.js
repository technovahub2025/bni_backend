const multer = require("multer");
const { parse } = require("csv-parse/sync");
const Lead = require("../models/Lead");
const Message = require("../models/Message");
const WorkflowRun = require("../models/WorkflowRun");
const ScheduledJob = require("../models/ScheduledJob");
const ActivityLog = require("../models/ActivityLog");
const { logActivity } = require("../services/logService");
const { redisQueueEnabled } = require("../queues/workflowQueue");
const { stopWorkflowForLead } = require("../services/workflowService");

const upload = multer({ storage: multer.memoryStorage() });

function normalizePhone(phone = "") {
  return phone.replace(/[^\d+]/g, "");
}

async function uploadLeadsCsv(req, res) {
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });
  const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
  const leads = records.map((row) => {
    const { name, phone, source, ...customFields } = row;
    return {
      name: name || "Unknown",
      phone: normalizePhone(phone),
      source: source || "csv_upload",
      customFields
    };
  });

  const ops = leads.map((lead) => ({
    updateOne: {
      filter: { phone: lead.phone },
      update: { $setOnInsert: lead },
      upsert: true
    }
  }));
  if (ops.length) await Lead.bulkWrite(ops);
  await logActivity("csv_upload", { count: leads.length });
  res.json({ uploaded: leads.length });
}

async function getLeads(req, res) {
  const query = {};
  if (req.query.status) query.status = req.query.status;
  if (req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: "i" } },
      { phone: { $regex: req.query.search, $options: "i" } }
    ];
  }
  if (req.query.minScore || req.query.maxScore) {
    query.score = {};
    if (req.query.minScore) query.score.$gte = Number(req.query.minScore);
    if (req.query.maxScore) query.score.$lte = Number(req.query.maxScore);
  }
  if (req.query.tag) query.tags = req.query.tag;

  const leads = await Lead.find(query).sort({ createdAt: -1 }).lean();
  const enriched = await Promise.all(
    leads.map(async (lead) => {
      const [lastOutbound, lastInbound, activeRun] = await Promise.all([
        Message.findOne({ leadId: lead._id, direction: "outbound" }).sort({ createdAt: -1 }).lean(),
        Message.findOne({ leadId: lead._id, direction: "inbound" }).sort({ createdAt: -1 }).lean(),
        WorkflowRun.findOne({ leadId: lead._id, state: "running" }).sort({ createdAt: -1 }).lean()
      ]);
      return {
        ...lead,
        lastOutbound,
        lastInbound,
        activeRun
      };
    })
  );

  const now = Date.now();
  const windows = {
    today: 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  const lastActivityWindow = req.query.lastActivity;
  const finalLeads = windows[lastActivityWindow]
    ? enriched.filter((lead) => {
        const lastAt = new Date(
          lead.lastInbound?.createdAt || lead.lastOutbound?.createdAt || lead.updatedAt
        ).getTime();
        return now - lastAt <= windows[lastActivityWindow];
      })
    : enriched;

  res.json(finalLeads);
}

async function getLeadById(req, res) {
  const lead = await Lead.findById(req.params.id).lean();
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const [messages, runs, scheduledJobs, activityLogs] = await Promise.all([
    Message.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean(),
    WorkflowRun.find({ leadId: lead._id }).sort({ createdAt: -1 }).lean(),
    ScheduledJob.find({ leadId: lead._id }).sort({ executeAt: 1 }).lean(),
    ActivityLog.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(100).lean()
  ]);
  res.json({
    ...lead,
    messages,
    workflowRuns: runs,
    scheduledJobs,
    activityLogs,
    runtime: {
      redisEnabled: redisQueueEnabled
    }
  });
}

async function updateLead(req, res) {
  const allowed = ["status", "stage", "score", "tags"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const lead = await Lead.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  await logActivity("lead_updated", updates, lead._id);
  res.json(lead);
}

async function deleteLead(req, res) {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  await stopWorkflowForLead(lead._id, "lead_deleted");

  await Promise.all([
    Message.deleteMany({ leadId: lead._id }),
    WorkflowRun.deleteMany({ leadId: lead._id }),
    ScheduledJob.deleteMany({ leadId: lead._id }),
    ActivityLog.deleteMany({ leadId: lead._id })
  ]);

  await lead.deleteOne();
  await logActivity("lead_deleted", { leadId: String(req.params.id), phone: lead.phone });
  return res.json({ deleted: true });
}

module.exports = {
  upload,
  uploadLeadsCsv,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead
};
