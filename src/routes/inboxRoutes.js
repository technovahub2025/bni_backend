const express = require("express");
const { getInboxThreads, getInboxThreadByLead } = require("../controllers/inboxController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.get("/", asyncHandler(getInboxThreads));
router.get("/:leadId", asyncHandler(getInboxThreadByLead));

module.exports = router;
