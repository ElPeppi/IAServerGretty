import { Router } from 'express';
import multer from 'multer';
import { AsignacionController } from '../controllers/AsignacionController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new AsignacionController();

router.use(authenticate);

router.get('/', (req, res) => controller.listar(req, res));
router.post('/', upload.single('excelFile'), (req, res) => controller.subir(req, res));
router.post('/actualizar', (req, res) => controller.actualizar(req, res));
router.post('/:id/generar-poderes', (req, res) => controller.generarPoderes(req, res));
router.post('/:id/poder', upload.single('poderFile'), (req, res) => controller.subirPoder(req, res));
router.post('/:id/generar-demandas', (req, res) => controller.generarDemandas(req, res));

export default router;
