const express = require("express");
const {
  upload,
  uploadLeadsCsv,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead
} = require("../controllers/leadsController");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

router.post("/upload", upload.single("file"), asyncHandler(uploadLeadsCsv));
router.get("/", asyncHandler(getLeads));
router.get("/:id", asyncHandler(getLeadById));
router.patch("/:id", asyncHandler(updateLead));
router.delete("/:id", asyncHandler(deleteLead));

module.exports = router;
