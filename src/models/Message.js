const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      index: true
    },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    templateName: { type: String, default: null },
    body: { type: String, default: "" },
    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "read", "failed"],
      default: "queued"
    },
    providerMessageId: { type: String, default: null, index: true },
    error: { type: String, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", MessageSchema);
