const mongoose = require("mongoose");

const TemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    body: { type: String, required: true },
    active: { type: Boolean, default: true },
    category: {
      type: String,
      enum: ["marketing", "utility", "authentication"],
      default: "marketing"
    },
    variables: [{ type: String }],
    lastUsedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Template", TemplateSchema);
