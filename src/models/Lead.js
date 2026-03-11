const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true, index: true, unique: true },
    status: {
      type: String,
      enum: ["new", "nurturing", "qualified", "unqualified", "no_response"],
      default: "new"
    },
    score: { type: Number, default: 0 },
    stage: {
      type: String,
      enum: ["application", "conversation", "onboarding", null],
      default: null
    },
    source: { type: String, default: "csv_upload" },
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    optOut: { type: Boolean, default: false },
    tags: [{ type: String }],
    scoreBreakdown: [
      {
        rule: String,
        points: Number,
        message: String,
        createdAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Lead", LeadSchema);
