import { Router } from 'express';
import { ConfigController } from '../controllers/ConfigController';
import { authenticate, requireAdmin } from '../middlewares/authMiddleware';

const router = Router();
const controller = new ConfigController();

// La configuración (SMMV y directorio de tránsito) la pueden ver y EDITAR todos
// los usuarios autenticados: tanto administradores como abogados (LAWYER).
router.use(authenticate);
router.get('/', (req, res) => controller.get(req, res));
router.patch('/', (req, res) => controller.update(req, res));

// Plantillas e insumos: el ORIGEN es Drive y se sincronizan solos antes de cada
// lote. Aquí solo se consulta el estado (cualquiera) y se fuerza la sincronización
// o se restaura una versión anterior (solo ADMIN: afecta a todas las demandas).
router.get('/plantillas', (req, res) => controller.plantillas(req, res));
router.post('/plantillas/sincronizar', requireAdmin, (req, res) =>
  controller.sincronizarPlantillas(req, res),
);
router.post('/plantillas/:clave/restaurar', requireAdmin, (req, res) =>
  controller.restaurarPlantilla(req, res),
);

export default router;
