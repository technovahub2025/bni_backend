const assert = require("assert");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");

function createQuery(doc) {
  return {
    sort() {
      return this;
    },
    lean: async () => (doc ? { ...doc } : null),
    then(resolve, reject) {
      return Promise.resolve(doc).then(resolve, reject);
    }
  };
}

function setMock(modulePath, exports) {
  const resolved = require.resolve(path.join(projectRoot, modulePath));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

function clearModule(modulePath) {
  const resolved = require.resolve(path.join(projectRoot, modulePath));
  delete require.cache[resolved];
}

function createRunStore() {
  const runs = [];

  function queryForRun(run) {
    return {
      sort() {
        return this;
      },
      then(resolve, reject) {
        return Promise.resolve(run).then(resolve, reject);
      }
    };
  }

  class RunDoc {
    constructor(data) {
      Object.assign(this, data);
    }

    async save() {
      this.updatedAt = new Date();
      return this;
    }
  }

  return {
    runs,
    model: {
      findOne(query) {
        const matches = runs
          .filter((run) => String(run.leadId) === String(query.leadId) && run.state === query.state)
          .sort((a, b) => a.createdAt - b.createdAt);
        return queryForRun(matches.at(-1) || null);
      },
      async create(data) {
        const run = new RunDoc({
          _id: `run_${runs.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          currentStepIndex: 0,
          state: "running",
          ...data
        });
        runs.push(run);
        return run;
      }
    }
  };
}

function createLeadStore() {
  const leads = new Map();
  let leadCount = 0;

  function attachSave(lead) {
    return {
      ...lead,
      async save() {
        leads.set(String(this.phone), this);
        return this;
      }
    };
  }

  return {
    insert(data) {
      leadCount += 1;
      const lead = attachSave({
        _id: data._id || `lead_${leadCount}`,
        status: "new",
        stage: null,
        score: 0,
        scoreBreakdown: [],
        customFields: {},
        optOut: false,
        ...data
      });
      leads.set(String(lead.phone), lead);
      return lead;
    },
    async create(data) {
      return this.insert(data);
    },
    async findOne(query) {
      return leads.get(String(query.phone)) || null;
    },
    async findById(id) {
      return Array.from(leads.values()).find((lead) => String(lead._id) === String(id)) || null;
    },
    all() {
      return Array.from(leads.values());
    }
  };
}

function createMessageStore() {
  const messages = [];

  return {
    messages,
    model: {
      async create(data) {
        const message = { _id: `message_${messages.length + 1}`, ...data };
        messages.push(message);
        return message;
      },
      async exists() {
        return false;
      },
      async findOneAndUpdate() {
        return null;
      }
    }
  };
}

function buildHarness({ steps, preloadedLead = null }) {
  const leadStore = createLeadStore();
  const messageStore = createMessageStore();

  const workflow = {
    _id: "workflow_1",
    name: "reply_flow_test",
    type: "reply_flow",
    active: true,
    settings: {},
    replyFlow: {
      initialTemplate: "initial_template",
      initialTemplateVariables: [],
      steps
    }
  };

  const sentTemplates = [];
  const activityLogs = [];
  const scheduledJobs = [];
  const runStore = createRunStore();
  let activeLead = preloadedLead
    ? leadStore.insert({
        ...preloadedLead,
        status: "new",
        stage: null,
        score: 0,
        scoreBreakdown: [],
        customFields: {},
        optOut: false
      })
    : null;

  setMock("src/models/Lead.js", leadStore);
  setMock("src/models/Workflow.js", {
    findOne: () => createQuery(workflow),
    findById: () =>
      createQuery({
        ...workflow,
        toObject() {
          return { ...workflow };
        }
      })
  });
  setMock("src/models/WorkflowRun.js", runStore.model);
  setMock("src/models/ScheduledJob.js", {
    find: async () => scheduledJobs,
    deleteMany: async () => ({ deletedCount: scheduledJobs.length }),
    create: async (data) => data
  });
  setMock("src/models/Message.js", messageStore.model);
  setMock("src/models/WorkspaceSettings.js", {
    findOne: () => ({
      lean: async () => null
    })
  });
  setMock("src/queues/workflowQueue.js", {
    workflowQueue: {
      remove: async () => {},
      add: async () => {
        throw new Error("not used in reply flow test");
      }
    },
    redisQueueEnabled: false
  });
  setMock("src/services/whatsappService.js", {
    sendTemplateMessage: async ({ templateName, templateParams }) => {
      sentTemplates.push({ templateName, templateParams });
      return { _id: `msg_${sentTemplates.length}`, templateName };
    }
  });
  setMock("src/services/logService.js", {
    logActivity: async (type, payload, leadId, runId) => {
      activityLogs.push({ type, payload, leadId, runId });
    }
  });
  setMock("src/services/leadScoring.js", {
    calculateScore: () => ({ total: 0, breakdown: [] })
  });
  setMock("src/config/env.js", {
    workflowDelayTemplate2Ms: 120000,
    workflowDelayTemplate3Ms: 180000,
    workflowDelayNoResponseMs: 86400000,
    whatsappVerifyToken: "verify-token",
    membershipLink: "http://localhost:3000/apply",
    appBaseUrl: "http://localhost:3000",
    zoomMeetingLink: "https://zoom.us/j/1234567890?pwd=dummy-demo-link"
  });
  setMock("src/services/workspaceSettingsService.js", {
    getMessagingConfig: async () => ({
      webhookVerificationToken: "verify-token"
    })
  });

  clearModule("src/services/workflowService.js");
  clearModule("src/controllers/webhookController.js");
  const workflowService = require(path.join(projectRoot, "src/services/workflowService.js"));
  const webhookController = require(path.join(projectRoot, "src/controllers/webhookController.js"));

  return {
    get lead() {
      return activeLead || leadStore.all()[0] || null;
    },
    leadStore,
    messages: messageStore.messages,
    workflowService,
    webhookController,
    sentTemplates,
    activityLogs,
    runs: runStore.runs
  };
}

async function runButtonFlowTest() {
  const harness = buildHarness({
    preloadedLead: {
      _id: "lead_1",
      name: "Alice",
      phone: "+15550001111"
    },
    steps: [
      {
        id: "step_yes",
        triggerType: "button_click",
        triggerValue: "YES_PAYLOAD",
        nextTemplate: "yes_template",
        nextTemplateVariables: []
      }
    ]
  });

  await harness.workflowService.handleInboundReply(harness.lead, { body: "hello there", buttonPayload: "" });

  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template"],
    "The initial template should be sent on the first inbound message."
  );
  assert.strictEqual(harness.runs.length, 1, "The first inbound message should create a reply-flow run.");
  assert.strictEqual(
    harness.runs[0].currentStep,
    "awaiting_reply_selection",
    "The run should wait for the user's explicit selection after the initial template is sent."
  );
  assert.strictEqual(harness.runs[0].state, "running", "The run should remain active after the initial template.");

  await harness.workflowService.handleInboundReply(harness.lead, {
    body: "Yes",
    buttonPayload: "YES_PAYLOAD"
  });

  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template", "yes_template"],
    "Selecting a mapped button should send the corresponding template."
  );
  assert.strictEqual(harness.runs[0].state, "completed", "The run should complete after sending the mapped reply template.");
}

async function runExactReplyFlowTest() {
  const harness = buildHarness({
    preloadedLead: {
      _id: "lead_1",
      name: "Alice",
      phone: "+15550001111"
    },
    steps: [
      {
        id: "step_apply",
        triggerType: "user_reply",
        triggerValue: "apply now",
        nextTemplate: "apply_template",
        nextTemplateVariables: []
      }
    ]
  });

  await harness.workflowService.handleInboundReply(harness.lead, { body: "anything", buttonPayload: "" });
  await harness.workflowService.handleInboundReply(harness.lead, { body: "apply now", buttonPayload: "" });

  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template", "apply_template"],
    "An exact text reply should send the configured mapped template."
  );
}

async function runMembershipLinkFallbackTest() {
  const harness = buildHarness({
    preloadedLead: {
      _id: "lead_1",
      name: "Unknown",
      phone: "+15550001111"
    },
    steps: [
      {
        id: "step_apply",
        triggerType: "button_click",
        triggerValue: "FILL_FORM",
        nextTemplate: "application_form_link",
        nextTemplateVariables: []
      }
    ]
  });

  await harness.workflowService.handleInboundReply(harness.lead, { body: "start", buttonPayload: "" });
  await harness.workflowService.handleInboundReply(harness.lead, {
    body: "Fill Application Form",
    buttonPayload: "FILL_FORM"
  });

  const membershipSend = harness.sentTemplates.find((item) => item.templateName === "application_form_link");
  assert.ok(membershipSend, "The application link template should be sent.");
  assert.ok(
    Array.isArray(membershipSend.templateParams) &&
      membershipSend.templateParams[0] === "http://localhost:3000/apply?leadId=lead_1&phone=%2B15550001111&name=Unknown",
    "The membership application template should receive the generated application link instead of the lead name."
  );
}

async function runWebhookEndToEndTest() {
  const harness = buildHarness({
    steps: [
      {
        id: "step_yes",
        triggerType: "button_click",
        triggerValue: "YES_PAYLOAD",
        nextTemplate: "yes_template",
        nextTemplateVariables: []
      }
    ]
  });

  const req1 = {
    body: {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.1",
                    from: "+15550001111",
                    text: { body: "Hi" }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
  const req2 = {
    body: {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.2",
                    from: "+15550001111",
                    interactive: {
                      button_reply: {
                        id: "YES_PAYLOAD",
                        title: "Yes"
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
  const res = {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    }
  };

  await harness.webhookController.handleWebhook(req1, res);
  await harness.webhookController.handleWebhook(req2, res);

  assert.strictEqual(res.statusCode, 200, "Webhook handler should acknowledge inbound events.");
  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template", "yes_template"],
    "The webhook path should send the initial template first, then the mapped template for the selected button."
  );
  assert.strictEqual(harness.messages.length, 2, "Inbound webhook messages should be recorded.");
}

async function runWebhookFlowReplyParsingTest() {
  const harness = buildHarness({
    steps: [
      {
        id: "step_slot",
        triggerType: "button_click",
        triggerValue: "slot_10_am",
        nextTemplate: "slot_confirmed_template",
        nextTemplateVariables: []
      }
    ]
  });

  const res = {
    statusCode: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    }
  };

  await harness.webhookController.handleWebhook(
    {
      body: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.flow-start",
                      from: "+15550001111",
                      text: { body: "hi" }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    },
    res
  );

  await harness.webhookController.handleWebhook(
    {
      body: {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.flow-reply",
                      from: "+15550001111",
                      interactive: {
                        nfm_reply: {
                          name: "flow_reply",
                          response_json: JSON.stringify({
                            flow_token: "flow_123",
                            slot: "slot_10_am"
                          })
                        }
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    },
    res
  );

  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template", "slot_confirmed_template"],
    "Flow replies should advance the reply workflow using the parsed nfm_reply value."
  );
  assert.strictEqual(
    harness.messages.at(-1)?.body,
    "slot_10_am",
    "The inbound flow reply should be stored with the extracted slot value instead of an empty body."
  );
}

async function runMeetingFlowSequenceTest() {
  const harness = buildHarness({
    steps: [
      {
        id: "step_attend",
        triggerType: "button_click",
        triggerValue: "Attend Meeting",
        nextTemplate: "nexion_meeting_schedule",
        nextTemplateVariables: []
      },
      {
        id: "step_slot",
        triggerType: "button_click",
        triggerValue: "__flow_reply__",
        nextTemplate: "nexion_zoom_link",
        nextTemplateVariables: [
          { variable: "var_1", source: "selected_meeting_time" },
          { variable: "var_2", source: "zoom_meeting_link" }
        ]
      },
      {
        id: "step_apply",
        triggerType: "button_click",
        triggerValue: "Fill Application Form",
        nextTemplate: "application_form_link",
        nextTemplateVariables: [{ variable: "var_1", source: "application_form_link" }]
      }
    ],
    preloadedLead: {
      _id: "lead_1",
      name: "Alice",
      phone: "+15550001111"
    }
  });

  await harness.workflowService.handleInboundReply(harness.lead, { body: "hi", buttonPayload: "" });
  await harness.workflowService.handleInboundReply(harness.lead, {
    body: "Attend Meeting",
    buttonPayload: "Attend Meeting"
  });

  assert.deepStrictEqual(
    harness.sentTemplates.map((item) => item.templateName),
    ["initial_template", "nexion_meeting_schedule"],
    "The Attend Meeting button should send the meeting schedule template first."
  );
  assert.strictEqual(harness.runs[0].state, "running", "The run should stay active while waiting for the slot selection.");

  await harness.workflowService.handleInboundReply(harness.lead, {
    body: "06:00 PM",
    buttonPayload: "06:00 PM",
    selectedMeetingTime: "06:00 PM",
    isFlowReply: true
  });

  const zoomTemplateSend = harness.sentTemplates.find((item) => item.templateName === "nexion_zoom_link");
  assert.ok(zoomTemplateSend, "Selecting a slot should send the nexion_zoom_link template.");
  assert.deepStrictEqual(
    zoomTemplateSend.templateParams,
    ["06:00 PM", "https://zoom.us/j/1234567890?pwd=dummy-demo-link"],
    "The zoom template should receive the selected meeting time first and the zoom link second."
  );
  assert.strictEqual(harness.runs[0].state, "running", "The workflow should remain active because another branch can still be matched later.");
}

async function main() {
  await runButtonFlowTest();
  await runExactReplyFlowTest();
  await runMembershipLinkFallbackTest();
  await runWebhookEndToEndTest();
  await runWebhookFlowReplyParsingTest();
  await runMeetingFlowSequenceTest();
  process.stdout.write("Reply flow tests passed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
