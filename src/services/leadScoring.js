const DEFAULT_SCORING_CONFIG = {
  normalReplyScore: 20,
  keywordReplyScore: 50,
  replyKeywords: ["interested", "yes", "apply"]
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeywords(replyKeywords = DEFAULT_SCORING_CONFIG.replyKeywords) {
  return Array.from(
    new Set(
      (Array.isArray(replyKeywords) ? replyKeywords : [])
        .map((keyword) => String(keyword || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function buildRules(config = {}) {
  const scoringConfig = {
    ...DEFAULT_SCORING_CONFIG,
    ...config
  };
  const normalizedKeywords = normalizeKeywords(scoringConfig.replyKeywords);
  const keywordRegexes = normalizedKeywords.map((keyword) => ({
    keyword,
    regex: new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i")
  }));

  return [
    {
      name: "any_reply",
      evaluate: ({ message }) => (message?.trim() ? scoringConfig.normalReplyScore : 0)
    },
    {
      name: "keyword_reply_bonus",
      evaluate: ({ normalizedMessage }) => {
        const matched = keywordRegexes.filter(({ regex }) => regex.test(normalizedMessage));
        if (matched.length === 0) return 0;
        return Math.max(0, scoringConfig.keywordReplyScore - scoringConfig.normalReplyScore);
      }
    },
    {
      name: "negative_keywords",
      evaluate: ({ normalizedMessage }) =>
        /\b(not interested|stop)\b/.test(normalizedMessage) ? -50 : 0
    }
  ];
}

function calculateScore(message, config = {}) {
  const normalizedMessage = (message || "").toLowerCase();
  const breakdown = buildRules(config)
    .map((rule) => ({ rule: rule.name, points: rule.evaluate({ message, normalizedMessage }) }))
    .filter((entry) => entry.points !== 0);
  const total = breakdown.reduce((acc, curr) => acc + curr.points, 0);
  return { total, breakdown };
}

module.exports = { calculateScore, DEFAULT_SCORING_CONFIG };
