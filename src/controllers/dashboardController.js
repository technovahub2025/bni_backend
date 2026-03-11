const Lead = require("../models/Lead");
const Message = require("../models/Message");
const WorkflowRun = require("../models/WorkflowRun");

async function getDashboardStats(req, res) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);

  const [activeNurturingLeads, repliesToday, qualifiedThisWeek, noResponseLast7Days, runningWorkflows, failedSends] =
    await Promise.all([
      Lead.countDocuments({ status: "nurturing" }),
      Message.countDocuments({ direction: "inbound", createdAt: { $gte: todayStart } }),
      Lead.countDocuments({ status: "qualified", updatedAt: { $gte: weekStart } }),
      Lead.countDocuments({ status: "no_response", updatedAt: { $gte: weekStart } }),
      WorkflowRun.countDocuments({ state: "running" }),
      Message.countDocuments({ direction: "outbound", status: "failed", createdAt: { $gte: weekStart } })
    ]);

  const recentReplies = await Message.find({ direction: "inbound" })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate("leadId", "name phone status")
    .lean();

  const stuckLeadIds = await WorkflowRun.find({
    state: "running",
    createdAt: { $lte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
  })
    .select("leadId")
    .lean();

  const [nurturingCount, qualifiedCount, onboardingCount] = await Promise.all([
    Lead.countDocuments({ status: "nurturing" }),
    Lead.countDocuments({ status: "qualified" }),
    Lead.countDocuments({ stage: "onboarding" })
  ]);

  res.json({
    kpis: {
      activeNurturingLeads,
      repliesToday,
      qualifiedThisWeek,
      noResponseLast7Days
    },
    automationHealth: {
      runningWorkflows,
      failedSends,
      stuckWaitingOver48h: stuckLeadIds.length
    },
    recentReplies,
    pipeline: [
      { name: "Nurturing", value: nurturingCount },
      { name: "Qualified", value: qualifiedCount },
      { name: "Onboarding", value: onboardingCount }
    ]
  });
}

module.exports = { getDashboardStats };
