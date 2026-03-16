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

  const normalizeFlowSelectionValue = (value) =>
    String(value || "")
      .trim()
      .replace(/(\d+)_([0-1]?\d:\d{2})_([AP]M)$/i, "$2 $3")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();

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

  const flattenFlowEntries = (value, prefix = "") => {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, nestedValue]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
        return flattenFlowEntries(nestedValue, nextPrefix);
      }
      if (Array.isArray(nestedValue)) {
        return nestedValue.flatMap((item, index) =>
          item && typeof item === "object"
            ? flattenFlowEntries(item, `${nextPrefix}[${index}]`)
            : [[`${nextPrefix}[${index}]`, item]]
        );
      }
      return [[nextPrefix, nestedValue]];
    });
  };

  const firstUsefulValue =
    parsedResponse && typeof parsedResponse === "object"
      ? flattenFlowEntries(parsedResponse).find(([key, value]) => {
          if (key === "flow_token") return false;
          return value !== undefined && value !== null && String(value).trim();
        })?.[1]
      : "";

  const normalizedEntries =
    parsedResponse && typeof parsedResponse === "object"
      ? flattenFlowEntries(parsedResponse).filter(([key, value]) => {
          if (String(key || "").endsWith("flow_token") || key === "flow_token") return false;
          return value !== undefined && value !== null && String(value).trim();
        })
      : [];

  const isDateLikeValue = (value) => {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) return true;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(normalizedValue)) return true;
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\s+\d{4}$/i.test(normalizedValue)) {
      return true;
    }
    const parsed = new Date(normalizedValue);
    return !Number.isNaN(parsed.getTime()) && !/^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test(normalizedValue);
  };

  const isTimeLikeValue = (value) => /^\d{1,2}:\d{2}(\s?[ap]m)?$/i.test(String(value || "").trim());

  const dateValue =
    normalizedEntries.find(([key, value]) => {
      const normalizedKey = String(key || "").toLowerCase();
      return /(date|day)/i.test(normalizedKey) || isDateLikeValue(value);
    })?.[1] || "";

  const timeValue =
    normalizedEntries.find(([key, value]) => {
      const normalizedKey = String(key || "").toLowerCase();
      return /(time|slot)/i.test(normalizedKey) || isTimeLikeValue(value);
    })?.[1] || "";

  const rawSelectionValue = String(firstUsefulValue || "").trim();

  const combinedMeetingSelection =
    [normalizeFlowSelectionValue(dateValue), normalizeFlowSelectionValue(timeValue)].filter(Boolean).join(" ").trim() ||
    normalizeFlowSelectionValue(rawSelectionValue);

  return {
    body: rawSelectionValue || String(flowReply?.body || "").trim() || responseJson,
    buttonPayload:
      rawSelectionValue ||
      String(flowReply?.body || "").trim() ||
      String(flowReply?.name || "").trim() ||
      responseJson,
    selectedMeetingTime: combinedMeetingSelection,
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
    const failureReason = Array.isArray(status?.errors) && status.errors[0]
      ? (
          status.errors[0].error_data?.details ||
          status.errors[0].title ||
          status.errors[0].message ||
          JSON.stringify(status.errors[0])
        )
      : null;

    const message = await Message.findOneAndUpdate(
      { providerMessageId: status.id },
      {
        status: status.status || "sent",
        error: failureReason
      },
      { new: true }
    );

    await logActivity(
      status.status === "failed" ? "whatsapp_delivery_failed" : "whatsapp_status_updated",
      {
        providerMessageId: status.id || null,
        status: status.status || "sent",
        error: failureReason,
        rawStatus: status
      },
      message?.leadId || null
    );
  }

  for (const inbound of messages) {
    try {
      const from = (inbound.from || "").replace(/[^\d+]/g, "");
      const flowReply = parseFlowReply(inbound);
      const body =
        (flowReply.isFlowReply ? flowReply.body : "") ||
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

      if (inbound.id) {
        const existingInbound = await Message.findOne({ providerMessageId: inbound.id }).lean();
        if (existingInbound) {
          await logActivity("inbound_duplicate_ignored", { providerMessageId: inbound.id, body }, existingInbound.leadId);
          continue;
        }
      }

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
      await logActivity(
        "inbound_received",
        {
          body,
          isFlowReply: flowReply.isFlowReply,
          parsedSelectedMeetingTime: flowReply.selectedMeetingTime || "",
          rawFlowReply: inbound?.interactive?.nfm_reply || null
        },
        lead._id
      );

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
    } catch (error) {
      await logActivity("webhook_message_failed", {
        providerMessageId: inbound?.id || null,
        error: error.message || "Unknown webhook processing error"
      });
    }
  }

  res.sendStatus(200);
}

module.exports = { verifyWebhook, handleWebhook };
