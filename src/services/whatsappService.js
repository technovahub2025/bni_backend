const axios = require("axios");
const env = require("../config/env");
const Message = require("../models/Message");
const { logActivity } = require("./logService");
const { findMetaTemplateByName } = require("./metaTemplateService");
const { getMessagingConfig } = require("./workspaceSettingsService");

async function createOutboundMessage(leadId, templateName, body = "") {
  return Message.create({
    leadId,
    direction: "outbound",
    templateName,
    body,
    status: "queued"
  });
}

function getFlowButton(templateDoc) {
  const templateComponents = Array.isArray(templateDoc?.components) ? templateDoc.components : [];
  const buttonsComponent = templateComponents.find((component) => component.type === "BUTTONS");
  const button = (buttonsComponent?.buttons || []).find(
    (item) => String(item?.type || "").toUpperCase() === "FLOW"
  );
  return button || null;
}

function getExpectedParamCount(templateDoc) {
  if (!templateDoc) return 0;
  const variableMappings = Array.isArray(templateDoc.variableMappings) ? templateDoc.variableMappings : [];
  if (variableMappings.length > 0) {
    const indexed = variableMappings
      .map((item) => /^var_(\d+)$/i.exec(String(item.variable)))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    if (indexed.length > 0) return Math.max(...indexed);
  }
  const variables = Array.isArray(templateDoc.variables) ? templateDoc.variables : [];
  if (variables.length > 0) {
    const indexed = variables
      .map((value) => /^var_(\d+)$/i.exec(String(value)))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    if (indexed.length > 0) return Math.max(...indexed);
    return variables.length;
  }
  const body = String(templateDoc.body || "");
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? matches.length : 0;
}

function buildTemplateParameters(lead, count) {
  const customValues = Object.values(lead.customFields || {}).map((v) => String(v));
  const defaults = [lead.name, lead.phone, ...customValues].filter(Boolean);
  const params = [];
  for (let i = 0; i < count; i += 1) {
    params.push({
      type: "text",
      text: defaults[i] || `value_${i + 1}`
    });
  }
  return params;
}

function buildComponentAwareParameters(lead, templateDoc, templateParams) {
  const variableMappings = Array.isArray(templateDoc?.variableMappings) ? templateDoc.variableMappings : [];
  const templateComponents = Array.isArray(templateDoc?.components) ? templateDoc.components : [];
  const flowButtons = templateComponents
    .filter((component) => component.type === "BUTTONS")
    .flatMap((component) =>
      (component.buttons || []).map((button, buttonIndex) => ({
        button,
        buttonIndex
      }))
    )
    .filter(({ button }) => String(button?.type || "").toUpperCase() === "FLOW")
    .map(({ buttonIndex }) => ({
      type: "button",
      sub_type: "flow",
      index: String(buttonIndex),
      parameters: [
        {
          type: "action",
          action: {
            flow_token: `flow_${lead._id}_${Date.now()}`,
            flow_action_data: {}
          }
        }
      ]
    }));

  if (!variableMappings.length) return flowButtons;

  const provided = Array.isArray(templateParams) ? templateParams.map((value) => String(value || "")) : [];
  const defaults = buildTemplateParameters(lead, getExpectedParamCount(templateDoc)).map((item) => item.text);
  const byVariable = new Map();

  variableMappings.forEach((mapping) => {
    const match = /^var_(\d+)$/i.exec(String(mapping.variable));
    const index = match ? Number(match[1]) - 1 : byVariable.size;
    if (!byVariable.has(mapping.variable)) {
      byVariable.set(mapping.variable, provided[index] || defaults[index] || `value_${index + 1}`);
    }
  });

  const bodyParams = variableMappings
    .filter((mapping) => mapping.componentType === "body")
    .sort((a, b) => Number(a.variable.split("_")[1] || 0) - Number(b.variable.split("_")[1] || 0))
    .map((mapping) => ({ type: "text", text: byVariable.get(mapping.variable) || "" }));

  const buttonGroups = new Map();
  variableMappings
    .filter((mapping) => mapping.componentType === "button")
    .forEach((mapping) => {
      const key = `${mapping.subType}:${mapping.buttonIndex}`;
      const existing = buttonGroups.get(key) || {
        type: "button",
        sub_type: mapping.subType || "url",
        index: String(mapping.buttonIndex || 0),
        parameters: []
      };
      existing.parameters.push({ type: "text", text: byVariable.get(mapping.variable) || "" });
      buttonGroups.set(key, existing);
    });

  const components = [];
  if (bodyParams.length) {
    components.push({ type: "body", parameters: bodyParams });
  }

  components.push(...Array.from(buttonGroups.values()));
  components.push(...flowButtons);
  return components;
}

function buildTemplateParametersFromInput(lead, count, providedParams) {
  const provided = Array.isArray(providedParams) ? providedParams.map((v) => String(v || "")) : [];
  if (count <= 0) {
    return provided.map((text) => ({ type: "text", text }));
  }

  const defaults = buildTemplateParameters(lead, count).map((item) => item.text);
  return Array.from({ length: count }, (_, index) => ({
    type: "text",
    text: provided[index] || defaults[index] || `value_${index + 1}`
  }));
}

function createTemplatePayload({
  lead,
  templateName,
  language,
  templateParams,
  expectedParamCount = 0,
  templateDoc = null
}) {
  const providedCount = Array.isArray(templateParams) ? templateParams.length : 0;
  const paramsToSend = Math.max(expectedParamCount || 0, providedCount || 0);

  const payload = {
    messaging_product: "whatsapp",
    to: lead.phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language }
    }
  };

  const componentAwareParameters = buildComponentAwareParameters(lead, templateDoc, templateParams);
  if (componentAwareParameters.length > 0) {
    payload.template.components = componentAwareParameters;
  } else if (paramsToSend > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: buildTemplateParametersFromInput(lead, paramsToSend, templateParams)
      }
    ];
  }

  return payload;
}

function createInteractiveFlowPayload({ lead, templateDoc }) {
  const flowButton = getFlowButton(templateDoc);
  if (!flowButton) return null;

  const parameters = {
    flow_message_version: "3",
    flow_token: `flow_${lead._id}_${Date.now()}`,
    flow_id: String(flowButton.flow_id),
    flow_cta: String(flowButton.text || "Open flow")
  };

  if (flowButton.flow_action) {
    parameters.flow_action = String(flowButton.flow_action).toLowerCase();
  }

  const payload = {
    messaging_product: "whatsapp",
    to: lead.phone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: {
        text: String(templateDoc?.body || "").trim()
      },
      action: {
        name: "flow",
        parameters
      }
    }
  };

  return payload;
}

function parseExpectedParamCountFromError(error) {
  const detail = error?.response?.data?.error?.error_data?.details || "";
  const match = String(detail).match(/expected number of params \((\d+)\)/i);
  return match ? Number(match[1]) : 0;
}

function isTranslationError(error) {
  const code = error?.response?.data?.error?.code;
  return code === 132001;
}

async function resolveTemplateDoc(templateName) {
  try {
    return await findMetaTemplateByName(templateName);
  } catch {
    return null;
  }
}

async function sendTemplateMessage({ lead, templateName, bodyFallback = "", templateParams = null }) {
  const messaging = await getMessagingConfig();
  const messageDoc = await createOutboundMessage(lead._id, templateName, bodyFallback);
  const endpoint = `https://graph.facebook.com/v21.0/${messaging.phoneNumberId}/messages`;
  const templateDoc = await resolveTemplateDoc(templateName);
  const expectedParamCount = getExpectedParamCount(templateDoc);
  const selectedLanguage = templateDoc?.language || messaging.templateLanguage;
  const flowPayload = getFlowButton(templateDoc)
    ? createInteractiveFlowPayload({ lead, templateDoc })
    : null;

  if (!messaging.accessToken || !messaging.phoneNumberId) {
    messageDoc.status = "sent";
    messageDoc.error = null;
    messageDoc.providerMessageId = `mock-${messageDoc._id}`;
    await messageDoc.save();
    await logActivity("whatsapp_mock_sent", { templateName }, lead._id);
    return messageDoc;
  }

  try {
    const payload =
      flowPayload ||
      createTemplatePayload({
        lead,
        templateName,
        language: selectedLanguage,
        templateParams,
        expectedParamCount,
        templateDoc
      });

    const { data } = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${messaging.accessToken}`,
        "Content-Type": "application/json"
      },
      timeout: env.metaApiTimeoutMs,
      signal: AbortSignal.timeout(env.metaApiTimeoutMs)
    });

    messageDoc.status = "sent";
    messageDoc.error = null;
    messageDoc.providerMessageId = data?.messages?.[0]?.id || `wa-${messageDoc._id}`;
    await messageDoc.save();
    await logActivity("whatsapp_sent", { templateName, provider: messageDoc.providerMessageId }, lead._id);
    return messageDoc;
  } catch (error) {
    if (isTranslationError(error) && templateDoc?.language && templateDoc.language !== selectedLanguage) {
      try {
        const translationRetryPayload = createTemplatePayload({
          lead,
          templateName,
          language: templateDoc.language,
          templateParams,
          expectedParamCount,
          templateDoc
        });

        const { data } = await axios.post(endpoint, translationRetryPayload, {
          headers: {
            Authorization: `Bearer ${messaging.accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: env.metaApiTimeoutMs,
          signal: AbortSignal.timeout(env.metaApiTimeoutMs)
        });

        messageDoc.status = "sent";
        messageDoc.error = null;
        messageDoc.providerMessageId = data?.messages?.[0]?.id || `wa-${messageDoc._id}`;
        await messageDoc.save();
        await logActivity(
          "whatsapp_sent_retry_with_language",
          { templateName, language: templateDoc.language, provider: messageDoc.providerMessageId },
          lead._id
        );
        return messageDoc;
      } catch (retryError) {
        error = retryError;
      }
    }

    const expectedFromError = parseExpectedParamCountFromError(error);
    if (expectedFromError > 0) {
      try {
        const retryPayload = createTemplatePayload({
          lead,
          templateName,
          language: selectedLanguage,
          templateParams,
          expectedParamCount: expectedFromError,
          templateDoc
        });

        const { data } = await axios.post(endpoint, retryPayload, {
          headers: {
            Authorization: `Bearer ${messaging.accessToken}`,
            "Content-Type": "application/json"
          },
          timeout: env.metaApiTimeoutMs,
          signal: AbortSignal.timeout(env.metaApiTimeoutMs)
        });

        messageDoc.status = "sent";
        messageDoc.error = null;
        messageDoc.providerMessageId = data?.messages?.[0]?.id || `wa-${messageDoc._id}`;
        await messageDoc.save();
        await logActivity(
          "whatsapp_sent_retry_with_params",
          { templateName, expectedFromError, provider: messageDoc.providerMessageId },
          lead._id
        );
        return messageDoc;
      } catch (retryError) {
        error = retryError;
      }
    }

    messageDoc.status = "failed";
    const metaCode = error?.response?.data?.error?.code;
    if (metaCode === 190) {
      error.message =
        "Meta auth failed (code 190). Access token is invalid/expired. Generate a new token and update WHATSAPP_TOKEN.";
    }
    if (metaCode === 10) {
      error.message =
        "Meta permission denied (code 10). Regenerate a System User token with whatsapp_business_messaging and whatsapp_business_management and ensure app/WABA/phone mapping is correct.";
    }
    messageDoc.error =
      error.response?.data?.error?.message ||
      error.response?.data?.error?.error_user_msg ||
      error.message;
    await messageDoc.save();
    await logActivity(
      "whatsapp_failed",
      { templateName, error: error.response?.data || error.message },
      lead._id
    );
    throw error;
  }
}

module.exports = { sendTemplateMessage };
