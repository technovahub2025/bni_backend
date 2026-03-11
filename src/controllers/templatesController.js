const { logActivity } = require("../services/logService");
const { fetchMetaTemplates } = require("../services/metaTemplateService");

function extractTemplateError(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.error?.error_user_msg ||
    error.message ||
    "Failed to fetch templates from Meta"
  );
}

async function createTemplate(req, res) {
  return res.status(405).json({
    error: "Templates are managed in Meta and are fetched live. Local template creation is disabled."
  });
}

async function getTemplates(req, res) {
  try {
    const templates = await fetchMetaTemplates();
    res.json(templates);
  } catch (error) {
    await logActivity("templates_fetch_failed", { error: extractTemplateError(error) });
    res.json([]);
  }
}

async function getMetaTemplates(req, res) {
  try {
    const templates = await fetchMetaTemplates();
    res.json(templates);
  } catch (error) {
    await logActivity("templates_fetch_failed", { error: extractTemplateError(error) });
    res.json([]);
  }
}

async function syncMetaTemplates(req, res) {
  try {
    const metaTemplates = await fetchMetaTemplates();
    await logActivity("templates_fetched_from_meta", { count: metaTemplates.length });
    res.json(metaTemplates);
  } catch (error) {
    await logActivity("templates_fetch_failed", { error: extractTemplateError(error) });
    res.json([]);
  }
}

module.exports = { createTemplate, getTemplates, getMetaTemplates, syncMetaTemplates };
