import { Router } from 'express';
import multer from 'multer';
import { GenerateController } from '../controllers/GenerateController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const controller = new GenerateController();

router.use(authenticate);
router.post('/from-excel', upload.single('file'), (req, res) => controller.fromExcel(req, res));

// Demandas singulares con el motor real (sac_scripts): Excel + correo del poder.
router.post(
  '/singular',
  upload.fields([{ name: 'excelFile', maxCount: 1 }, { name: 'correoPoder', maxCount: 1 }]),
  (req, res) => controller.singular(req, res)
);

export default router;
