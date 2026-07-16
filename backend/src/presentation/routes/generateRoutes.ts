import { Router } from 'express';
import multer from 'multer';
import { GenerateController } from '../controllers/GenerateController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new GenerateController();

router.use(authenticate);
router.post('/from-excel', upload.single('file'), (req, res) => controller.fromExcel(req, res));

// Descarga de obligaciones del SAC por cédula (reemplaza el ZIP/n8n).
// Acepta cédulas pegadas (body.cedulas) y/o el Excel de asignación (campo excelFile,
// de donde se sacan las cédulas de la columna IDENTIFICACION).
router.post('/descargar-sac', upload.single('excelFile'), (req, res) => controller.descargarSac(req, res));

// Demandas singulares con el motor real (sac_scripts): Excel + correo del poder.
router.post(
  '/singular',
  upload.fields([{ name: 'excelFile', maxCount: 1 }, { name: 'correoPoder', maxCount: 1 }]),
  (req, res) => controller.singular(req, res)
);

export default router;
