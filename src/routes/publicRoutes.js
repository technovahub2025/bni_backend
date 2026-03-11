const express = require("express");
const { captureLead, getApplicationStatus, submitApplication } = require("../controllers/publicController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.post("/capture", asyncHandler(captureLead));
router.get("/application", asyncHandler(getApplicationStatus));
router.post("/application", asyncHandler(submitApplication));

module.exports = router;
