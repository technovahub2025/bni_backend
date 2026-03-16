const Notification = require("../models/Notification");

async function getNotifications(req, res) {
  const notifications = await Notification.find({})
    .sort({ readAt: 1, createdAt: -1 })
    .limit(50)
    .populate("leadId", "name phone status stage")
    .populate("meetingId", "status scheduledFor channel")
    .lean();
  res.json(notifications);
}

async function markNotificationRead(req, res) {
  const notification = await Notification.findByIdAndUpdate(
    req.params.id,
    { $set: { readAt: new Date() } },
    { new: true }
  )
    .populate("leadId", "name phone status stage")
    .populate("meetingId", "status scheduledFor channel")
    .lean();

  if (!notification) return res.status(404).json({ error: "Notification not found" });
  res.json(notification);
}

module.exports = {
  getNotifications,
  markNotificationRead
};
