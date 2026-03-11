const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");
const {
  startWorkflow,
  stopWorkflowForLead,
  DEFAULT_TEMPLATE_CONFIG
} = require("../services/workflowService");

async function getWorkflows(req, res) {
  const [workflows, activeRuns] = await Promise.all([
    Workflow.find({}).sort({ createdAt: -1 }).lean(),
    WorkflowRun.find({ state: "running" }).populate("leadId", "name phone status stage").lean()
  ]);
  const normalized = workflows.map((workflow) => ({
    ...workflow,
    settings: {
      ...DEFAULT_TEMPLATE_CONFIG,
      ...(workflow.settings || {})
    }
  }));
  res.json({ workflows: normalized, activeRuns });
}

async function startWorkflowForLead(req, res) {
  const run = await startWorkflow(req.params.leadId);
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

  res.json({ workflow, activeRunsUpdated });
}

module.exports = {
  getWorkflows,
  startWorkflowForLead,
  stopWorkflowForLeadController,
  updateWorkflow
};
