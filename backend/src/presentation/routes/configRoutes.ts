import { Router } from 'express';
import { ConfigController } from '../controllers/ConfigController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new ConfigController();

// La configuración (SMMV y directorio de tránsito) la pueden ver y EDITAR todos
// los usuarios autenticados: tanto administradores como abogados (LAWYER).
router.use(authenticate);
router.get('/', (req, res) => controller.get(req, res));
router.patch('/', (req, res) => controller.update(req, res));

export default router;
