const dotenv = require("dotenv");

dotenv.config();

function toBool(value, defaultValue = true) {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function toPositiveNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function cleanText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().replace(/^["']|["']$/g, "");
}

const appBaseUrl = cleanText(process.env.APP_BASE_URL, "http://localhost:3000");

const env = {
  port: Number(process.env.PORT || 5000),
  mongoUri: cleanText(process.env.MONGO_URI, "mongodb://localhost:27017/lead_automation"),
  redisUrl: cleanText(process.env.REDIS_URL, "redis://localhost:6379"),
  redisEnabled: toBool(process.env.REDIS_ENABLED, true),
  whatsappToken: cleanText(process.env.WHATSAPP_TOKEN, ""),
  whatsappPhoneNumberId: cleanText(process.env.WHATSAPP_PHONE_NUMBER_ID, ""),
  whatsappBusinessAccountId: cleanText(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, ""),
  whatsappTemplateLanguage: cleanText(process.env.WHATSAPP_TEMPLATE_LANGUAGE, "en_US"),
  whatsappVerifyToken: cleanText(process.env.WHATSAPP_VERIFY_TOKEN, "verify-token"),
  workflowDelayTemplate2Ms: toPositiveNumber(process.env.WORKFLOW_DELAY_TEMPLATE_2_MS, 2 * 60 * 1000),
  workflowDelayTemplate3Ms: toPositiveNumber(process.env.WORKFLOW_DELAY_TEMPLATE_3_MS, 3 * 60 * 1000),
  workflowDelayNoResponseMs: toPositiveNumber(
    process.env.WORKFLOW_DELAY_NO_RESPONSE_MS,
    24 * 60 * 60 * 1000
  ),
  metaApiTimeoutMs: toPositiveNumber(process.env.META_API_TIMEOUT_MS, 20000),
  appBaseUrl,
  membershipLink: cleanText(process.env.MEMBERSHIP_LINK, `${appBaseUrl}/apply`),
  zoomMeetingLink: cleanText(process.env.ZOOM_MEETING_LINK, "")
};

module.exports = env;
