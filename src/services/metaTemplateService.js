const axios = require("axios");
const env = require("../config/env");
const { getMessagingConfig } = require("./workspaceSettingsService");

const TEMPLATE_CACHE_TTL_MS = 60 * 1000;
let templateCache = {
  key: "",
  expiresAt: 0,
  templates: null
};

function normalizeMetaTemplate(metaTemplate) {
  const bodyComponent = (metaTemplate.components || []).find((c) => c.type === "BODY");
  const body = bodyComponent?.text || "";
  const bodyVariables = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => `var_${m[1]}`);
  const buttonVariables = (metaTemplate.components || [])
    .filter((component) => component.type === "BUTTONS")
    .flatMap((component) =>
      (component.buttons || []).flatMap((button, buttonIndex) => {
        const source = String(button.url || button.text || "");
        return [...source.matchAll(/\{\{(\d+)\}\}/g)].map((match) => ({
          variable: `var_${match[1]}`,
          componentType: "button",
          buttonIndex,
          subType: String(button.type || "").toLowerCase() || "url"
        }));
      })
    );
  const variables = [
    ...bodyVariables.map((variable) => ({ variable, componentType: "body" })),
    ...buttonVariables
  ];

  return {
    id: metaTemplate.id,
    name: metaTemplate.name,
    category: (metaTemplate.category || "marketing").toLowerCase(),
    status: metaTemplate.status,
    language: metaTemplate.language,
    body,
    variables: variables.map((item) => item.variable),
    variableMappings: variables,
    components: metaTemplate.components || [],
    fromMeta: true,
    updatedAt: metaTemplate.updated_time || metaTemplate.created_time || null
  };
}

async function fetchMetaTemplates(options = {}) {
  const { forceRefresh = false } = options;
  const messaging = await getMessagingConfig();
  const cacheKey = `${messaging.whatsappBusinessAccountId}:${messaging.templateLanguage}`;

  if (
    !forceRefresh &&
    templateCache.templates &&
    templateCache.key === cacheKey &&
    templateCache.expiresAt > Date.now()
  ) {
    return templateCache.templates;
  }

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
  templateCache = {
    key: cacheKey,
    expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS,
    templates
  };
  return templates;
}

async function findMetaTemplateByName(templateName, options = {}) {
  const templates = await fetchMetaTemplates(options);
  const messaging = await getMessagingConfig();

  return (
    templates.find(
      (template) =>
        template.name === templateName &&
        template.language === messaging.templateLanguage &&
        template.status === "APPROVED"
    ) ||
    templates.find((template) => template.name === templateName && template.status === "APPROVED") ||
    templates.find((template) => template.name === templateName) ||
    null
  );
}

module.exports = { fetchMetaTemplates, findMetaTemplateByName };
