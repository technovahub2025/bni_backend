const express = require("express");
const {
  getWorkflows,
  startWorkflowForLead,
  stopWorkflowForLeadController,
  updateWorkflow
} = require("../controllers/workflowController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.get("/", asyncHandler(getWorkflows));
router.post("/start/:leadId", asyncHandler(startWorkflowForLead));
router.post("/stop/:leadId", asyncHandler(stopWorkflowForLeadController));
router.patch("/:workflowId", asyncHandler(updateWorkflow));

module.exports = router;
