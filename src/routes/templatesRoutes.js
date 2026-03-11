const express = require("express");
const {
  createTemplate,
  getTemplates,
  getMetaTemplates,
  syncMetaTemplates
} = require("../controllers/templatesController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();
router.get("/", asyncHandler(getTemplates));
router.get("/meta", asyncHandler(getMetaTemplates));
router.post("/sync-meta", asyncHandler(syncMetaTemplates));
router.post("/", asyncHandler(createTemplate));

module.exports = router;
