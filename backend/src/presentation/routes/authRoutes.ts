import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { authenticate, requireAdmin } from '../middlewares/authMiddleware';

const router = Router();
const controller = new AuthController();

router.post('/login', (req, res) => controller.login(req, res));
// El registro queda restringido a ADMIN/TI (la creación normal es por /api/users).
router.post('/register', authenticate, requireAdmin, (req, res) => controller.register(req, res));
router.get('/me', authenticate, (req, res) => controller.me(req, res));
router.patch('/profile', authenticate, (req, res) => controller.updateProfile(req, res));
router.patch('/password', authenticate, (req, res) => controller.changePassword(req, res));

export default router;
