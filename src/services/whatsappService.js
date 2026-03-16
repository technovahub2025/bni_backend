const axios = require("axios");
const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const Message = require("../models/Message");
const { logActivity } = require("./logService");
const { findMetaTemplateByName } = require("./metaTemplateService");
const { getMessagingConfig } = require("./workspaceSettingsService");

const uploadedTemplateMediaCache = new Map();

async function createOutboundMessage(leadId, templateName, body = "") {
  return Message.create({
    leadId,
    direction: "outbound",
    templateName,
    body,
    status: "queued"
  });
}

async function createTextMessage(leadId, body = "") {
  return Message.create({
    leadId,
    direction: "outbound",
    templateName: null,
    body,
    status: "queued"
  });
}

function getHeaderComponent(templateDoc) {
  const templateComponents = Array.isArray(templateDoc?.components) ? templateDoc.components : [];
  return templateComponents.find((component) => component.type === "HEADER") || null;
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

function resolveConfiguredMediaLink(templateName) {
  const configuredLinks = env.whatsappTemplateMediaLinks || {};
  const directMatch = configuredLinks?.[templateName];
  if (directMatch) return String(directMatch).trim();

  const normalizedTemplateName = String(templateName || "").trim().toLowerCase();
  const normalizedMatch = Object.entries(configuredLinks).find(
    ([key]) => String(key).trim().toLowerCase() === normalizedTemplateName
  );
  return normalizedMatch ? String(normalizedMatch[1]).trim() : "";
}

function resolveConfiguredMediaId(templateName) {
  const configuredIds = env.whatsappTemplateMediaIds || {};
  const directMatch = configuredIds?.[templateName];
  if (directMatch) return String(directMatch).trim();

  const normalizedTemplateName = String(templateName || "").trim().toLowerCase();
  const normalizedMatch = Object.entries(configuredIds).find(
    ([key]) => String(key).trim().toLowerCase() === normalizedTemplateName
  );
  return normalizedMatch ? String(normalizedMatch[1]).trim() : "";
}

function resolveHeaderMediaLink(templateDoc, templateName, mediaHeaderLink = "") {
  const headerComponent = getHeaderComponent(templateDoc);
  const exampleHandles = headerComponent?.example?.header_handle;
  const explicitLink = String(mediaHeaderLink || "").trim();
  if (explicitLink) return explicitLink;
  const configuredLink = resolveConfiguredMediaLink(templateName);
  if (configuredLink) return configuredLink;
  if (Array.isArray(exampleHandles) && exampleHandles[0]) {
    return String(exampleHandles[0]).trim();
  }
  return "";
}

function resolveLocalMediaPath(mediaSource) {
  const normalizedSource = String(mediaSource || "").trim();
  if (!normalizedSource) return "";
  if (/^https?:\/\//i.test(normalizedSource)) return "";

  const absolutePath = path.isAbsolute(normalizedSource)
    ? normalizedSource
    : path.resolve(process.cwd(), normalizedSource);

  return fs.existsSync(absolutePath) ? absolutePath : "";
}

function mimeTypeFromPath(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".mp4") return "video/mp4";
  return "";
}

async function uploadMediaFromLink(mediaLink, messaging, templateName) {
  const normalizedLink = String(mediaLink || "").trim();
  if (!normalizedLink) return "";

  const localMediaPath = resolveLocalMediaPath(normalizedLink);
  const localMediaStat = localMediaPath ? fs.statSync(localMediaPath) : null;
  const cacheKey = localMediaPath
    ? `${messaging.phoneNumberId}:${templateName}:${localMediaPath}:${localMediaStat.size}:${localMediaStat.mtimeMs}`
    : `${messaging.phoneNumberId}:${templateName}:${normalizedLink}`;
  if (uploadedTemplateMediaCache.has(cacheKey)) {
    return uploadedTemplateMediaCache.get(cacheKey);
  }

  let mimeType = "";
  let fileName = "";
  let fileBuffer = null;

  if (localMediaPath) {
    mimeType = mimeTypeFromPath(localMediaPath);
    if (!mimeType) {
      throw new Error(`Unsupported local media type for ${templateName}: ${localMediaPath}`);
    }
    fileName = path.basename(localMediaPath);
    fileBuffer = fs.readFileSync(localMediaPath);
  } else {
    const mediaResponse = await axios.get(normalizedLink, {
      responseType: "arraybuffer",
      timeout: env.metaApiTimeoutMs,
      signal: AbortSignal.timeout(env.metaApiTimeoutMs)
    });

    mimeType = String(mediaResponse.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mimeType) {
      throw new Error(`Unable to determine media mime type for ${templateName}`);
    }

    const extension = mimeType.split("/")[1] || "bin";
    fileName = `${String(templateName || "template").replace(/[^\w.-]+/g, "_")}.${extension}`;
    fileBuffer = mediaResponse.data;
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);

  const uploadEndpoint = `https://graph.facebook.com/v21.0/${messaging.phoneNumberId}/media`;
  const uploadResponse = await fetch(uploadEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${messaging.accessToken}`
    },
    body: form,
    signal: AbortSignal.timeout(env.metaApiTimeoutMs)
  });

  const uploadJson = await uploadResponse.json();
  if (!uploadResponse.ok || !uploadJson?.id) {
    throw new Error(uploadJson?.error?.message || `Meta media upload failed for ${templateName}`);
  }

  uploadedTemplateMediaCache.set(cacheKey, uploadJson.id);
  return uploadJson.id;
}

async function resolveHeaderMediaAsset({
  templateDoc,
  templateName,
  mediaHeaderLink = "",
  messaging
}) {
  const configuredMediaId = resolveConfiguredMediaId(templateName);
  if (configuredMediaId) {
    return { kind: "id", value: configuredMediaId };
  }

  const resolvedLink = resolveHeaderMediaLink(templateDoc, templateName, mediaHeaderLink);
  if (!resolvedLink) return { kind: "", value: "" };

  if (messaging?.accessToken && messaging?.phoneNumberId) {
    const uploadedMediaId = await uploadMediaFromLink(resolvedLink, messaging, templateName);
    if (uploadedMediaId) {
      return { kind: "id", value: uploadedMediaId };
    }
  }

  return { kind: "link", value: resolvedLink };
}

async function buildHeaderParameters({ templateDoc, templateName, mediaHeaderLink = "", messaging }) {
  const headerComponent = getHeaderComponent(templateDoc);
  const format = String(headerComponent?.format || "").toUpperCase();

  if (format === "IMAGE") {
    const asset = await resolveHeaderMediaAsset({
      templateDoc,
      templateName,
      mediaHeaderLink,
      messaging
    });
    if (!asset.value) return null;
    return {
      type: "header",
      parameters: [
        {
          type: "image",
          image: asset.kind === "id" ? { id: asset.value } : { link: asset.value }
        }
      ]
    };
  }

  if (format === "VIDEO") {
    const link = resolveHeaderMediaLink(templateDoc, templateName, mediaHeaderLink);
    if (!link) return null;
    return {
      type: "header",
      parameters: [
        {
          type: "video",
          video: {
            link
          }
        }
      ]
    };
  }

  if (format === "DOCUMENT") {
    const link = resolveHeaderMediaLink(templateDoc, templateName, mediaHeaderLink);
    if (!link) return null;
    return {
      type: "header",
      parameters: [
        {
          type: "document",
          document: {
            link,
            filename: link.split("/").pop() || "document"
          }
        }
      ]
    };
  }

  return null;
}

async function buildComponentAwareParameters(
  lead,
  templateDoc,
  templateName,
  templateParams,
  mediaHeaderLink = "",
  messaging = null
) {
  const variableMappings = Array.isArray(templateDoc?.variableMappings) ? templateDoc.variableMappings : [];
  const templateComponents = Array.isArray(templateDoc?.components) ? templateDoc.components : [];
  const headerParameters = await buildHeaderParameters({
    templateDoc,
    templateName,
    mediaHeaderLink,
    messaging
  });
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

  if (!variableMappings.length) {
    return [headerParameters, ...flowButtons].filter(Boolean);
  }

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
  if (headerParameters) {
    components.push(headerParameters);
  }
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

async function createTemplatePayload({
  lead,
  templateName,
  language,
  templateParams,
  mediaHeaderLink,
  expectedParamCount = 0,
  templateDoc = null,
  messaging = null
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

  const componentAwareParameters = await buildComponentAwareParameters(
    lead,
    templateDoc,
    templateName,
    templateParams,
    mediaHeaderLink,
    messaging
  );
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

async function sendTemplateMessage({
  lead,
  templateName,
  bodyFallback = "",
  templateParams = null,
  mediaHeaderLink = ""
}) {
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
      await createTemplatePayload({
        lead,
        templateName,
        language: selectedLanguage,
        templateParams,
        mediaHeaderLink,
        expectedParamCount,
        templateDoc,
        messaging
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
        const translationRetryPayload = await createTemplatePayload({
          lead,
          templateName,
          language: templateDoc.language,
          templateParams,
          mediaHeaderLink,
          expectedParamCount,
          templateDoc,
          messaging
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
        const retryPayload = await createTemplatePayload({
          lead,
          templateName,
          language: selectedLanguage,
          templateParams,
          mediaHeaderLink,
          expectedParamCount: expectedFromError,
          templateDoc,
          messaging
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

async function sendTextMessage({ lead, body }) {
  const messaging = await getMessagingConfig();
  const messageDoc = await createTextMessage(lead._id, body);
  const endpoint = `https://graph.facebook.com/v21.0/${messaging.phoneNumberId}/messages`;

  if (!messaging.accessToken || !messaging.phoneNumberId) {
    messageDoc.status = "sent";
    messageDoc.error = null;
    messageDoc.providerMessageId = `mock-text-${messageDoc._id}`;
    await messageDoc.save();
    await logActivity("whatsapp_mock_text_sent", { body }, lead._id);
    return messageDoc;
  }

  try {
    const payload = {
      messaging_product: "whatsapp",
      to: lead.phone,
      type: "text",
      text: {
        body: String(body || "").trim()
      }
    };

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
    messageDoc.providerMessageId = data?.messages?.[0]?.id || `wa-text-${messageDoc._id}`;
    await messageDoc.save();
    await logActivity("whatsapp_text_sent", { provider: messageDoc.providerMessageId, body }, lead._id);
    return messageDoc;
  } catch (error) {
    messageDoc.status = "failed";
    messageDoc.error =
      error.response?.data?.error?.message ||
      error.response?.data?.error?.error_user_msg ||
      error.message;
    await messageDoc.save();
    await logActivity("whatsapp_text_failed", { body, error: error.response?.data || error.message }, lead._id);
    throw error;
  }
}

module.exports = { sendTemplateMessage, sendTextMessage };
