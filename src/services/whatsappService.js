const axios = require("axios");
const env = require("../config/env");
const Message = require("../models/Message");
const { logActivity } = require("./logService");
const { fetchMetaTemplates } = require("./metaTemplateService");
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

function getExpectedParamCount(templateDoc) {
  if (!templateDoc) return 0;
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
  expectedParamCount = 0
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

  if (paramsToSend > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: buildTemplateParametersFromInput(lead, paramsToSend, templateParams)
      }
    ];
  }

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
    const messaging = await getMessagingConfig();
    const metaTemplates = await fetchMetaTemplates();
    const preferred =
      metaTemplates.find(
        (template) =>
          template.name === templateName &&
          template.language === messaging.templateLanguage &&
          template.status === "APPROVED"
      ) ||
      metaTemplates.find(
        (template) => template.name === templateName && template.status === "APPROVED"
      ) ||
      metaTemplates.find((template) => template.name === templateName);
    return preferred || null;
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

  if (!messaging.accessToken || !messaging.phoneNumberId) {
    messageDoc.status = "sent";
    messageDoc.error = null;
    messageDoc.providerMessageId = `mock-${messageDoc._id}`;
    await messageDoc.save();
    await logActivity("whatsapp_mock_sent", { templateName }, lead._id);
    return messageDoc;
  }

  try {
    const payload = createTemplatePayload({
      lead,
      templateName,
      language: selectedLanguage,
      templateParams,
      expectedParamCount
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
          expectedParamCount
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
          expectedParamCount: expectedFromError
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
