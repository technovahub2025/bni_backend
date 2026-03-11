const IORedis = require("ioredis");
const env = require("./env");

let connection = null;

if (env.redisEnabled) {
  connection = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy(times) {
      return Math.min(times * 500, 5000);
    }
  });

  let warned = false;
  connection.on("error", (error) => {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(`Redis unavailable (${error.code || error.message}). Queue features are degraded.`);
      warned = true;
    }
  });
}

module.exports = { connection };
