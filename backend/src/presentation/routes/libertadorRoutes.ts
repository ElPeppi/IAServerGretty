import { Router } from 'express';
import { LibertadorController } from '../controllers/LibertadorController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new LibertadorController();

router.use(authenticate);

// Casos del cuadro jurídico (Libertador no tiene lotes: la unidad es la solicitud).
router.get('/casos', (req, res) => controller.casos(req, res));
// Estados de cuenta de un conjunto de solicitudes (sin asignación de por medio).
router.post('/estados-cuenta', (req, res) => controller.estadosCuenta(req, res));

export default router;
