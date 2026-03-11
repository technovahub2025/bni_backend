const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");
const {
  startWorkflow,
  stopWorkflowForLead,
  deleteWorkflow,
  DEFAULT_TEMPLATE_CONFIG,
  DEFAULT_REPLY_FLOW_CONFIG,
  normalizeReplyFlowConfig,
  normalizeWorkflow
} = require("../services/workflowService");

async function getWorkflows(req, res) {
  const [workflows, activeRuns] = await Promise.all([
    Workflow.find({}).sort({ createdAt: -1 }).lean(),
    WorkflowRun.find({ state: "running" }).populate("leadId", "name phone status stage").lean()
  ]);
  const normalized = workflows.map((workflow) => normalizeWorkflow(workflow));
  res.json({ workflows: normalized, activeRuns });
}

async function createWorkflow(req, res) {
  const workflow = await Workflow.create({
    name: String(req.body?.name || "").trim() || `reply_flow_${Date.now()}`,
    type: "reply_flow",
    active: true,
    settings: DEFAULT_TEMPLATE_CONFIG,
    replyFlow: {
      ...DEFAULT_REPLY_FLOW_CONFIG,
      ...normalizeReplyFlowConfig(req.body?.replyFlow)
    }
  });

  res.status(201).json({ workflow: normalizeWorkflow(workflow.toObject()) });
}

async function startWorkflowForLead(req, res) {
  const run = await startWorkflow(req.params.leadId, req.body?.workflowId || null);
  res.json(run);
}

async function stopWorkflowForLeadController(req, res) {
  const run = await stopWorkflowForLead(req.params.leadId);
  res.json({ stopped: !!run, run });
}

async function updateWorkflow(req, res) {
  const { workflowId } = req.params;
  const updates = {};
  let normalizedSettings = null;
  let normalizedReplyFlow = null;

  if (typeof req.body.name === "string" && req.body.name.trim()) {
    updates.name = req.body.name.trim();
  }

  if (typeof req.body.active === "boolean") {
    updates.active = req.body.active;
  }

  if (req.body.settings) {
    normalizedSettings = {
      ...DEFAULT_TEMPLATE_CONFIG,
      ...req.body.settings
    };
    updates.settings = normalizedSettings;
  }

  if (req.body.replyFlow) {
    normalizedReplyFlow = normalizeReplyFlowConfig(req.body.replyFlow);
    updates.replyFlow = normalizedReplyFlow;
  }

  const workflow = await Workflow.findByIdAndUpdate(workflowId, updates, { new: true });
  if (!workflow) return res.status(404).json({ error: "Workflow not found" });

  let activeRunsUpdated = 0;
  if (normalizedSettings) {
    const result = await WorkflowRun.updateMany(
      { workflowId: workflow._id, state: "running" },
      { $set: { templateConfig: normalizedSettings } }
    );
    activeRunsUpdated = result.modifiedCount || 0;
  }

  res.json({ workflow: normalizeWorkflow(workflow.toObject()), activeRunsUpdated });
}

async function deleteWorkflowController(req, res) {
  const workflow = await deleteWorkflow(req.params.workflowId);
  res.json({ deleted: true, workflowId: String(workflow._id) });
}

module.exports = {
  getWorkflows,
  createWorkflow,
  startWorkflowForLead,
  stopWorkflowForLeadController,
  updateWorkflow,
  deleteWorkflowController
};
