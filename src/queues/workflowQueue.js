const { Queue } = require("bullmq");
const { connection } = require("../config/redis");

const WORKFLOW_QUEUE = "workflow-events";
const redisQueueEnabled = !!connection;

let workflowQueue = null;

if (redisQueueEnabled) {
  workflowQueue = new Queue(WORKFLOW_QUEUE, { connection });
  let warned = false;
  workflowQueue.on("error", (error) => {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(`Workflow queue degraded (${error.code || error.message}). Falling back when needed.`);
      warned = true;
    }
  });
} else {
  workflowQueue = {
    add: async () => {
      throw new Error("Redis queue is disabled");
    },
    remove: async () => {}
  };
}

module.exports = { workflowQueue, WORKFLOW_QUEUE, redisQueueEnabled };
