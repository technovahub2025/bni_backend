const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const {
  getMeetings,
  createMeeting,
  updateMeeting
} = require("../controllers/meetingsController");

const router = express.Router();

router.get("/", asyncHandler(getMeetings));
router.post("/", asyncHandler(createMeeting));
router.patch("/:id", asyncHandler(updateMeeting));

module.exports = router;
