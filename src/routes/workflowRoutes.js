const express = require("express");
const {
  getWorkflows,
  createWorkflow,
  startWorkflowForLead,
  stopWorkflowForLeadController,
  updateWorkflow,
  deleteWorkflowController
} = require("../controllers/workflowController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.get("/", asyncHandler(getWorkflows));
router.post("/", asyncHandler(createWorkflow));
router.post("/start/:leadId", asyncHandler(startWorkflowForLead));
router.post("/stop/:leadId", asyncHandler(stopWorkflowForLeadController));
router.patch("/:workflowId", asyncHandler(updateWorkflow));
router.delete("/:workflowId", asyncHandler(deleteWorkflowController));

module.exports = router;
