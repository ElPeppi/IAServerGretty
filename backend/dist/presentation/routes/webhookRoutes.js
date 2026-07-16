"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const WebhookController_1 = require("../controllers/WebhookController");
const router = (0, express_1.Router)();
const controller = new WebhookController_1.WebhookController();
// Called by n8n after generating a document from Excel
router.post('/document-generated', (req, res) => controller.documentGenerated(req, res));
// Called by n8n to update document status
router.post('/update-status', (req, res) => controller.updateStatus(req, res));
exports.default = router;
//# sourceMappingURL=webhookRoutes.js.map