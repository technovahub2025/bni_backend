const axios = require("axios");
const env = require("../config/env");
const { getMessagingConfig } = require("./workspaceSettingsService");

function normalizeMetaTemplate(metaTemplate) {
  const bodyComponent = (metaTemplate.components || []).find((c) => c.type === "BODY");
  const body = bodyComponent?.text || "";
  const variables = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => `var_${m[1]}`);
  return {
    id: metaTemplate.id,
    name: metaTemplate.name,
    category: (metaTemplate.category || "marketing").toLowerCase(),
    status: metaTemplate.status,
    language: metaTemplate.language,
    body,
    variables,
    fromMeta: true,
    updatedAt: metaTemplate.updated_time || metaTemplate.created_time || null
  };
}

async function fetchMetaTemplates() {
  const messaging = await getMessagingConfig();

  if (!messaging.accessToken || !messaging.whatsappBusinessAccountId) {
    const error = new Error("Meta credentials missing");
    error.status = 400;
    throw error;
  }

  const url = `https://graph.facebook.com/v21.0/${messaging.whatsappBusinessAccountId}/message_templates`;
  const { data } = await axios.get(url, {
    params: {
      fields: "id,name,language,status,category,components,updated_time,created_time",
      limit: 100
    },
    headers: {
      Authorization: `Bearer ${messaging.accessToken}`
    },
    timeout: env.metaApiTimeoutMs,
    signal: AbortSignal.timeout(env.metaApiTimeoutMs)
  });

  const templates = (data?.data || []).map(normalizeMetaTemplate);
  return templates;
}

module.exports = { fetchMetaTemplates };
