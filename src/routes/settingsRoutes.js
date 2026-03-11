const express = require("express");
const { getWorkspaceSettings, updateWorkspaceSettings } = require("../controllers/settingsController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.get("/", asyncHandler(getWorkspaceSettings));
router.patch("/", asyncHandler(updateWorkspaceSettings));

module.exports = router;
