const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const {
  getNotifications,
  markNotificationRead
} = require("../controllers/notificationsController");

const router = express.Router();

router.get("/", asyncHandler(getNotifications));
router.patch("/:id/read", asyncHandler(markNotificationRead));

module.exports = router;
