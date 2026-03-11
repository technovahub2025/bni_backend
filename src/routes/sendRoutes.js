const express = require("express");
const { sendMessage } = require("../controllers/sendController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.post("/", asyncHandler(sendMessage));

module.exports = router;
