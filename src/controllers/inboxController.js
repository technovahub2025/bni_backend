const Message = require("../models/Message");
const Lead = require("../models/Lead");

async function getInboxThreads(req, res) {
  const inboundMessages = await Message.find({ direction: "inbound" })
    .sort({ createdAt: -1 })
    .populate("leadId", "name phone status score stage")
    .lean();

  const deduped = [];
  const seen = new Set();
  for (const msg of inboundMessages) {
    const leadId = String(msg.leadId?._id || "");
    if (!leadId || seen.has(leadId)) continue;
    seen.add(leadId);
    deduped.push(msg);
    if (deduped.length >= 40) break;
  }
  res.json(deduped);
}

async function getInboxThreadByLead(req, res) {
  const lead = await Lead.findById(req.params.leadId).lean();
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  const messages = await Message.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean();
  res.json({ lead, messages });
}

module.exports = { getInboxThreads, getInboxThreadByLead };
