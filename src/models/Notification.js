const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },
    meetingId: { type: mongoose.Schema.Types.ObjectId, ref: "Meeting", default: null },
    readAt: { type: Date, default: null }
  },
  { timestamps: true }
);

NotificationSchema.index({ readAt: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
