const env = require("../config/env");
const Lead = require("../models/Lead");
const Message = require("../models/Message");
const { handleInboundReply } = require("../services/workflowService");
const { logActivity } = require("../services/logService");
const { getMessagingConfig } = require("../services/workspaceSettingsService");

function parseFlowReply(inbound) {
  const flowReply = inbound?.interactive?.nfm_reply;
  if (!flowReply) {
    return { body: "", buttonPayload: "", selectedMeetingTime: "", isFlowReply: false };
  }

  const rawResponseJson = flowReply?.response_json;
  const responseJson =
    typeof rawResponseJson === "string"
      ? rawResponseJson
      : rawResponseJson && typeof rawResponseJson === "object"
        ? JSON.stringify(rawResponseJson)
        : "";

  const parsedResponse =
    typeof rawResponseJson === "string"
      ? (() => {
          try {
            return JSON.parse(rawResponseJson);
          } catch {
            return null;
          }
        })()
      : rawResponseJson && typeof rawResponseJson === "object"
        ? rawResponseJson
        : null;

  const firstUsefulValue =
    parsedResponse && typeof parsedResponse === "object"
      ? Object.entries(parsedResponse).find(([key, value]) => {
          if (key === "flow_token") return false;
          return value !== undefined && value !== null && String(value).trim();
        })?.[1]
      : "";

  return {
    body:
      String(flowReply?.body || "").trim() ||
      String(firstUsefulValue || "").trim() ||
      responseJson,
    buttonPayload:
      String(firstUsefulValue || "").trim() ||
      String(flowReply?.body || "").trim() ||
      String(flowReply?.name || "").trim() ||
      responseJson,
    selectedMeetingTime: String(firstUsefulValue || "").trim(),
    isFlowReply: true
  };
}

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
    const flowReply = parseFlowReply(inbound);
    const body =
      inbound?.text?.body ||
      inbound?.button?.text ||
      inbound?.interactive?.button_reply?.title ||
      inbound?.interactive?.list_reply?.title ||
      flowReply.body ||
      "";
    const buttonPayload =
      inbound?.interactive?.button_reply?.id ||
      inbound?.interactive?.button_reply?.title ||
      inbound?.button?.payload ||
      inbound?.button?.text ||
      inbound?.interactive?.list_reply?.id ||
      inbound?.interactive?.list_reply?.title ||
      flowReply.buttonPayload ||
      "";
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

    await handleInboundReply(lead, {
      body,
      buttonPayload,
      selectedMeetingTime: flowReply.selectedMeetingTime,
      isFlowReply: flowReply.isFlowReply
    });
  }

  res.sendStatus(200);
}

module.exports = { verifyWebhook, handleWebhook };
