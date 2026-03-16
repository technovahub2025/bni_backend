const express = require("express");
const leadsRoutes = require("./leadsRoutes");
const templatesRoutes = require("./templatesRoutes");
const sendRoutes = require("./sendRoutes");
const workflowRoutes = require("./workflowRoutes");
const dashboardRoutes = require("./dashboardRoutes");
const inboxRoutes = require("./inboxRoutes");
const publicRoutes = require("./publicRoutes");
const reportsRoutes = require("./reportsRoutes");
const settingsRoutes = require("./settingsRoutes");
const meetingsRoutes = require("./meetingsRoutes");
const notificationsRoutes = require("./notificationsRoutes");

const router = express.Router();

router.use("/leads", leadsRoutes);
router.use("/templates", templatesRoutes);
router.use("/send", sendRoutes);
router.use("/workflows", workflowRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/inbox", inboxRoutes);
router.use("/public", publicRoutes);
router.use("/reports", reportsRoutes);
router.use("/settings", settingsRoutes);
router.use("/meetings", meetingsRoutes);
router.use("/notifications", notificationsRoutes);

module.exports = router;
