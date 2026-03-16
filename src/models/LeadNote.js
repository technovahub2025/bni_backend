const mongoose = require("mongoose");

const LeadNoteSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true
    },
    authorName: { type: String, default: "Operator View" },
    body: { type: String, required: true, trim: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeadNote", LeadNoteSchema);
