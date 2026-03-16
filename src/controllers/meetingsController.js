const mongoose = require("mongoose");
const Meeting = require("../models/Meeting");
const Lead = require("../models/Lead");
const Notification = require("../models/Notification");
const { logActivity } = require("../services/logService");

async function getMeetings(req, res) {
  const meetings = await Meeting.find({})
    .sort({ scheduledFor: 1, createdAt: -1 })
    .populate("leadId", "name phone status stage")
    .lean();
  res.json(meetings);
}

async function createMeeting(req, res) {
  const leadId = String(req.body.leadId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(leadId)) {
    return res.status(400).json({ error: "leadId is invalid" });
  }

  const lead = await Lead.findById(leadId);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const meeting = await Meeting.create({
    leadId: lead._id,
    title: String(req.body.title || "Lead Consultation").trim() || "Lead Consultation",
    status: req.body.status === "scheduled" ? "scheduled" : "requested",
    channel: req.body.channel === "call" ? "call" : "zoom",
    scheduledFor: req.body.scheduledFor || null,
    joinUrl: String(req.body.joinUrl || "").trim(),
    notes: String(req.body.notes || "").trim(),
    source: String(req.body.source || "manual").trim() || "manual"
  });

  await Notification.create({
    type: "meeting_created",
    title: `Meeting created for ${lead.name}`,
    body: meeting.scheduledFor ? "A new meeting has been scheduled." : "A meeting request is waiting for review.",
    leadId: lead._id,
    meetingId: meeting._id
  });
  await logActivity("meeting_created", { meetingId: String(meeting._id) }, lead._id);

  const populatedMeeting = await Meeting.findById(meeting._id)
    .populate("leadId", "name phone status stage")
    .lean();
  res.status(201).json(populatedMeeting);
}

async function updateMeeting(req, res) {
  const updates = {};
  if (req.body.status) updates.status = req.body.status;
  if (req.body.channel) updates.channel = req.body.channel;
  if (req.body.scheduledFor !== undefined) updates.scheduledFor = req.body.scheduledFor || null;
  if (req.body.joinUrl !== undefined) updates.joinUrl = String(req.body.joinUrl || "").trim();
  if (req.body.notes !== undefined) updates.notes = String(req.body.notes || "").trim();

  const meeting = await Meeting.findByIdAndUpdate(req.params.id, updates, { new: true })
    .populate("leadId", "name phone status stage")
    .lean();
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  if (meeting.leadId?._id) {
    await logActivity("meeting_updated", updates, meeting.leadId._id);
  }

  res.json(meeting);
}

module.exports = {
  getMeetings,
  createMeeting,
  updateMeeting
};
