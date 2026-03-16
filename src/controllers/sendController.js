const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const { sendTemplateMessage } = require("../services/whatsappService");
const { logActivity } = require("../services/logService");

async function sendMessage(req, res) {
  const { leadId, phone, templateName, bodyFallback, templateParams, mediaHeaderLink } = req.body;
  if (!templateName || (!leadId && !phone)) {
    return res.status(400).json({ error: "templateName and leadId/phone are required" });
  }

  let lead = null;
  if (leadId) {
    if (mongoose.isValidObjectId(leadId)) {
      lead = await Lead.findById(leadId);
    } else {
      const normalizedLeadId = String(leadId).replace(/[^\d+]/g, "");
      lead = await Lead.findOne({ phone: normalizedLeadId });
    }
  }
  if (!lead && phone) {
    const normalizedPhone = String(phone).replace(/[^\d+]/g, "");
    lead = await Lead.findOne({ phone: normalizedPhone });
    if (!lead && normalizedPhone) {
      lead = await Lead.create({
        name: "Test Recipient",
        phone: normalizedPhone,
        source: "test_send"
      });
    }
  }

  if (!lead && leadId && !mongoose.isValidObjectId(leadId)) {
    const normalizedLeadId = String(leadId).replace(/[^\d+]/g, "");
    if (normalizedLeadId) {
      lead = await Lead.findOne({ phone: normalizedLeadId });
      if (!lead) {
        lead = await Lead.create({
          name: "Test Recipient",
          phone: normalizedLeadId,
          source: "test_send"
        });
      }
    }
  }

  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.optOut) return res.status(400).json({ error: "Lead opted out via STOP" });

  const sanitizedParams = Array.isArray(templateParams)
    ? templateParams.map((value) => String(value || ""))
    : null;

  const message = await sendTemplateMessage({
    lead,
    templateName,
    bodyFallback,
    templateParams: sanitizedParams,
    mediaHeaderLink: String(mediaHeaderLink || "").trim()
  });
  await logActivity("manual_send", { templateName }, lead._id);
  res.json(message);
}

module.exports = { sendMessage };
