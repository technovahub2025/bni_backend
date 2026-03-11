const env = require("../config/env");
const Lead = require("../models/Lead");
const Message = require("../models/Message");
const { handleInboundReply } = require("../services/workflowService");
const { logActivity } = require("../services/logService");
const { getMessagingConfig } = require("../services/workspaceSettingsService");

function extractWebhookData(payload) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const values = entries.flatMap((entry) =>
    Array.isArray(entry?.changes) ? entry.changes.map((change) => change?.value).filter(Boolean) : []
  );
  return {
    messages: values.flatMap((value) => value?.messages || []),
    statuses: values.flatMap((value) => value?.statuses || [])
  };
}

async function verifyWebhook(req, res) {
  const messaging = await getMessagingConfig();
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === messaging.webhookVerificationToken) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
}

async function handleWebhook(req, res) {
  const { messages, statuses } = extractWebhookData(req.body);
  await logActivity("webhook_received", { messages: messages.length, statuses: statuses.length });

  for (const status of statuses) {
    await Message.findOneAndUpdate(
      { providerMessageId: status.id },
      { status: status.status || "sent" }
    );
  }

  for (const inbound of messages) {
    const from = (inbound.from || "").replace(/[^\d+]/g, "");
    const body = inbound?.text?.body || "";
    let lead = await Lead.findOne({ phone: from });
    if (!lead && from) {
      lead = await Lead.create({
        name: "Unknown",
        phone: from,
        source: "webhook_inbound"
      });
      await logActivity("inbound_lead_auto_created", { from }, lead._id);
    }
    if (!lead) continue;

    await Message.create({
      leadId: lead._id,
      direction: "inbound",
      body,
      status: "read",
      providerMessageId: inbound.id || null
    });
    await logActivity("inbound_received", { body }, lead._id);

    if (/\bstop\b/i.test(body)) {
      lead.optOut = true;
      lead.status = "unqualified";
      await lead.save();
      await logActivity("stop_opt_out", { body }, lead._id);
    }

    await handleInboundReply(lead, body);
  }

  res.sendStatus(200);
}

module.exports = { verifyWebhook, handleWebhook };
