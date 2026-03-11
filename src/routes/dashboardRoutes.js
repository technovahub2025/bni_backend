const express = require("express");
const { getDashboardStats } = require("../controllers/dashboardController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.get("/", asyncHandler(getDashboardStats));

module.exports = router;
