const WorkspaceSettings = require("../models/WorkspaceSettings");
const env = require("../config/env");

async function getMessagingConfig() {
  const settings = await WorkspaceSettings.findOne({ key: "default" }).lean();
  const messaging = settings?.messaging || {};

  return {
    accessToken: String(messaging.accessToken || env.whatsappToken || "").trim(),
    phoneNumberId: String(messaging.phoneNumberId || env.whatsappPhoneNumberId || "").trim(),
    whatsappBusinessAccountId: String(
      messaging.whatsappBusinessAccountId || env.whatsappBusinessAccountId || ""
    ).trim(),
    webhookVerificationToken: String(
      messaging.webhookVerificationToken || env.whatsappVerifyToken || ""
    ).trim(),
    templateLanguage: String(env.whatsappTemplateLanguage || "en_US").trim()
  };
}

module.exports = {
  getMessagingConfig
};
