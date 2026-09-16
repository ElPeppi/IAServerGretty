import { Router } from 'express';
import multer from 'multer';
import { AsignacionController } from '../controllers/AsignacionController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new AsignacionController();

router.use(authenticate);

router.get('/', (req, res) => controller.listar(req, res));
router.get('/:id/personas', (req, res) => controller.personas(req, res));
router.post('/', upload.single('excelFile'), (req, res) => controller.subir(req, res));
router.post('/actualizar', (req, res) => controller.actualizar(req, res));
// Libertador: crear asignación por lista de solicitudes (sin Excel), y generar
// sus poderes de conciliación (uno por caso, subido a la carpeta del caso en Drive).
router.post('/libertador', (req, res) => controller.crearLibertador(req, res));
router.post('/:id/generar-poderes-libertador', (req, res) => controller.generarPoderesLibertador(req, res));
router.post('/:id/generar-poderes', (req, res) => controller.generarPoderes(req, res));
router.post('/:id/poder', upload.single('poderFile'), (req, res) => controller.subirPoder(req, res));
// multipart: opcionalmente trae `correoPoder` (PDF del correo del banco → ANEXO 1).
router.post('/:id/generar-demandas', upload.single('correoPoder'), (req, res) =>
  controller.generarDemandas(req, res),
);
// Trámite de PAGO DIRECTO. Va como multipart: opcionalmente trae `correoPoder`
// (PDF del otorgamiento → ANEXO 1), igual que generar-demandas. Sin este multer,
// req.body queda undefined y parseCedulas(req.body.cedulas) revienta.
router.post('/:id/generar-garantias', upload.single('correoPoder'), (req, res) =>
  controller.generarGarantias(req, res),
);

export default router;
