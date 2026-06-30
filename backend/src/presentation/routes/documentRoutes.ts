import { Router } from 'express';
import multer from 'multer';
import { DocumentController } from '../controllers/DocumentController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new DocumentController();

// .docx editado desde el navegador (hasta 25 MB) → se sobreescribe en el NAS.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(authenticate);

router.get('/', (req, res) => controller.getAll(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.post('/:id/sign', (req, res) => controller.sign(req, res));
router.put('/:id/file', upload.single('file'), (req, res) => controller.saveFile(req, res));

export default router;
