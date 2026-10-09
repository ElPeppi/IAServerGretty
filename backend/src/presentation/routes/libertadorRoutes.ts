import { Router } from 'express';
import { LibertadorController } from '../controllers/LibertadorController';
import { authenticate, authenticateN8n } from '../middlewares/authMiddleware';

const router = Router();
const controller = new LibertadorController();

// Lo llama n8n al recibir una asignación por correo: va ANTES del router.use(authenticate)
// porque n8n no tiene JWT, se autoriza con N8N_SECRET.
router.post('/carpetas', authenticateN8n, (req, res) => controller.carpetas(req, res));

router.use(authenticate);

// Casos del cuadro jurídico (Libertador no tiene lotes: la unidad es la solicitud).
router.get('/casos', (req, res) => controller.casos(req, res));
// Estados de cuenta de un conjunto de solicitudes (sin asignación de por medio).
router.post('/estados-cuenta', (req, res) => controller.estadosCuenta(req, res));

export default router;
