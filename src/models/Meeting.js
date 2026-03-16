const mongoose = require("mongoose");

const MeetingSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true
    },
    title: { type: String, default: "Lead Consultation" },
    status: {
      type: String,
      enum: ["requested", "scheduled", "completed", "cancelled"],
      default: "requested"
    },
    channel: {
      type: String,
      enum: ["zoom", "call"],
      default: "zoom"
    },
    scheduledFor: { type: Date, default: null },
    joinUrl: { type: String, default: "" },
    notes: { type: String, default: "" },
    source: { type: String, default: "automation" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Meeting", MeetingSchema);
