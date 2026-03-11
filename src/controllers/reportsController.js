const Lead = require("../models/Lead");
const Message = require("../models/Message");
const Workflow = require("../models/Workflow");
const WorkflowRun = require("../models/WorkflowRun");

function percentage(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function roundHours(milliseconds) {
  if (!milliseconds || milliseconds < 0) return 0;
  return Math.round((milliseconds / (1000 * 60 * 60)) * 10) / 10;
}

async function getReports(req, res) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const trendStart = new Date(now);
  trendStart.setHours(0, 0, 0, 0);
  trendStart.setDate(trendStart.getDate() - 8);

  const [
    totalLeads,
    qualifiedLeads,
    qualifiedThisMonth,
    onboardingCompleted,
    averageLeadScoreResult,
    highQualityLeads,
    outboundMessages,
    deliveredMessages,
    readMessages,
    distinctLeadsContacted,
    distinctReplyingLeads,
    totalWorkflows,
    totalWorkflowRuns,
    completedWorkflowRuns,
    inboundMessagesForTrend,
    messagesForResponseTime
  ] = await Promise.all([
    Lead.countDocuments({}),
    Lead.countDocuments({ status: "qualified" }),
    Lead.countDocuments({ status: "qualified", updatedAt: { $gte: monthStart } }),
    Lead.countDocuments({ stage: "onboarding" }),
    Lead.aggregate([{ $group: { _id: null, average: { $avg: "$score" } } }]),
    Lead.countDocuments({ score: { $gte: 80 } }),
    Message.countDocuments({ direction: "outbound" }),
    Message.countDocuments({ direction: "outbound", status: { $in: ["sent", "delivered", "read"] } }),
    Message.countDocuments({ direction: "outbound", status: "read" }),
    Message.distinct("leadId", { direction: "outbound" }),
    Message.distinct("leadId", { direction: "inbound" }),
    Workflow.countDocuments({}),
    WorkflowRun.countDocuments({}),
    WorkflowRun.countDocuments({ state: "completed" }),
    Message.aggregate([
      {
        $match: {
          direction: "inbound",
          createdAt: { $gte: trendStart }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt"
            }
          },
          replies: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Message.find({ direction: { $in: ["inbound", "outbound"] } })
      .select("leadId direction createdAt")
      .sort({ leadId: 1, createdAt: 1 })
      .lean()
  ]);

  const trendMap = new Map(inboundMessagesForTrend.map((entry) => [entry._id, entry.replies]));
  const replyTrend = Array.from({ length: 9 }, (_, index) => {
    const day = new Date(trendStart);
    day.setDate(trendStart.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    return {
      date: day.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      replies: trendMap.get(key) || 0
    };
  });

  const responseTracker = new Map();
  let responseSamples = 0;
  let responseTimeTotalMs = 0;

  for (const message of messagesForResponseTime) {
    const leadId = String(message.leadId || "");
    if (!leadId) continue;

    const current = responseTracker.get(leadId) || { lastOutboundAt: null };

    if (message.direction === "outbound") {
      current.lastOutboundAt = new Date(message.createdAt).getTime();
      responseTracker.set(leadId, current);
      continue;
    }

    const inboundAt = new Date(message.createdAt).getTime();
    if (current.lastOutboundAt && inboundAt >= current.lastOutboundAt) {
      responseTimeTotalMs += inboundAt - current.lastOutboundAt;
      responseSamples += 1;
      current.lastOutboundAt = null;
      responseTracker.set(leadId, current);
    }
  }

  const engagedLeads = await Lead.countDocuments({
    status: { $in: ["nurturing", "qualified", "unqualified", "no_response"] }
  });

  res.json({
    summary: {
      conversionRate: percentage(qualifiedLeads, totalLeads),
      replyRate: percentage(distinctReplyingLeads.length, distinctLeadsContacted.length),
      qualifiedLeads: qualifiedThisMonth,
      onboardingCompleted
    },
    replyTrend,
    funnel: [
      { stage: "New Leads", count: await Lead.countDocuments({ status: "new" }) },
      { stage: "Engaged", count: engagedLeads },
      { stage: "Replied", count: distinctReplyingLeads.length },
      { stage: "Qualified", count: qualifiedLeads },
      { stage: "Onboarded", count: onboardingCompleted }
    ],
    messagePerformance: {
      messagesSent: outboundMessages,
      deliveryRate: percentage(deliveredMessages, outboundMessages),
      readRate: percentage(readMessages, outboundMessages)
    },
    automationEfficiency: {
      totalWorkflows,
      avgResponseTimeHours: responseSamples ? roundHours(responseTimeTotalMs / responseSamples) : 0,
      successRate: percentage(completedWorkflowRuns, totalWorkflowRuns)
    },
    leadQuality: {
      avgLeadScore: Math.round((averageLeadScoreResult[0]?.average || 0) * 10) / 10,
      highQualityRate: percentage(highQualityLeads, totalLeads),
      qualificationRate: percentage(qualifiedLeads, totalLeads)
    }
  });
}

module.exports = { getReports };
