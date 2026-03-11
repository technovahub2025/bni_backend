const express = require("express");
const { getReports } = require("../controllers/reportsController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.get("/", asyncHandler(getReports));

module.exports = router;
