import { Router } from 'express';
import { DashboardController } from '../controllers/DashboardController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new DashboardController();

router.use(authenticate);
router.get('/stats', (req, res) => controller.getStats(req, res));
router.get('/observaciones', (req, res) => controller.getObservaciones(req, res));

export default router;
