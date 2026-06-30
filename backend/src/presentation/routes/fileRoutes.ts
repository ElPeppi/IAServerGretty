import { Router } from 'express';
import { FileController } from '../controllers/FileController';

const router = Router();
const controller = new FileController();

// Called by n8n to persist a generated or signed file
router.post('/upload', (req, res) => controller.upload(req, res));

export default router;
