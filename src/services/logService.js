const ActivityLog = require("../models/ActivityLog");

async function logActivity(type, payload = {}, leadId = null, runId = null) {
  await ActivityLog.create({ type, payload, leadId, runId });
}

module.exports = { logActivity };
