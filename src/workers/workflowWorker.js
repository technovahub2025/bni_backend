const { Worker } = require("bullmq");
const connectMongo = require("../config/db");
const { connection } = require("../config/redis");
const { WORKFLOW_QUEUE, redisQueueEnabled } = require("../queues/workflowQueue");
const { processScheduledJob } = require("../services/workflowService");
const ScheduledJob = require("../models/ScheduledJob");

async function startWorker() {
  await connectMongo();
  if (!redisQueueEnabled) {
    // eslint-disable-next-line no-console
    console.log("Workflow worker not started: Redis queue disabled");
    return;
  }

  const worker = new Worker(
    WORKFLOW_QUEUE,
    async (job) => {
      await processScheduledJob(job.name, job.data.leadId, job.data.runId, job.data.payload || null);
      await ScheduledJob.deleteOne({ bullJobId: job.id });
    },
    { connection }
  );

  worker.on("failed", (job, error) => {
    // eslint-disable-next-line no-console
    console.error(`Workflow job failed ${job?.id}:`, error.message);
  });

  // eslint-disable-next-line no-console
  console.log("Workflow worker started");
}

startWorker().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
