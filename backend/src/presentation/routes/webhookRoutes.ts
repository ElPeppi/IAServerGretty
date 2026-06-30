import { Router } from 'express';
import { WebhookController } from '../controllers/WebhookController';

const router = Router();
const controller = new WebhookController();

// Called by n8n after generating a document from Excel
router.post('/document-generated', (req, res) => controller.documentGenerated(req, res));

// Called by n8n to update document status
router.post('/update-status', (req, res) => controller.updateStatus(req, res));

export default router;
