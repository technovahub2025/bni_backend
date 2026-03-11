const express = require("express");
const cors = require("cors");
const apiRoutes = require("./routes");
const { verifyWebhook, handleWebhook } = require("./controllers/webhookController");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/webhook/whatsapp", verifyWebhook);
app.post("/webhook/whatsapp", async (req, res, next) => {
  try {
    await handleWebhook(req, res);
  } catch (error) {
    next(error);
  }
});
app.use("/api", apiRoutes);
app.use(errorHandler);

module.exports = app;
