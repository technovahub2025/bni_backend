const app = require("./app");
const env = require("./config/env");
const connectMongo = require("./config/db");
const { ensureDefaultWorkflow, initializeLocalScheduler } = require("./services/workflowService");

async function start() {
  await connectMongo();
  await ensureDefaultWorkflow();
  await initializeLocalScheduler();
  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on ${env.port}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
