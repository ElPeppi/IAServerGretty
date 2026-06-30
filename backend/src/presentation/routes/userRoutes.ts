import { Router } from 'express';
import { UsersController } from '../controllers/UsersController';
import { authenticate, requireAdmin } from '../middlewares/authMiddleware';

const router = Router();
const controller = new UsersController();

// Solo ADMIN/TI puede gestionar usuarios.
router.use(authenticate, requireAdmin);

router.get('/', (req, res) => controller.list(req, res));
router.post('/', (req, res) => controller.create(req, res));
router.get('/:id/password', (req, res) => controller.viewPassword(req, res));
router.patch('/:id/password', (req, res) => controller.resetPassword(req, res));
router.delete('/:id', (req, res) => controller.remove(req, res));

export default router;
