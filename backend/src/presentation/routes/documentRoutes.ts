import { Router } from 'express';
import multer from 'multer';
import { DocumentController } from '../controllers/DocumentController';
import { GenerateController } from '../controllers/GenerateController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new DocumentController();
const generateController = new GenerateController();

// .docx editado desde el navegador (hasta 25 MB) → se sobreescribe en el NAS.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.use(authenticate);

router.get('/', (req, res) => controller.getAll(req, res));
router.get('/:id', (req, res) => controller.getById(req, res));
router.post('/:id/sign', (req, res) => controller.sign(req, res));
// multipart opcional: `correoPoder` (PDF del banco → ANEXO 1). Si no viene, se
// reusa el guardado en la asignación; sin ninguno de los dos no se regenera.
router.post('/:id/regenerar', upload.single('correoPoder'), (req, res) =>
  generateController.regenerarUno(req, res),
);
router.put('/:id/file', upload.single('file'), (req, res) => controller.saveFile(req, res));
router.put('/:id/asignacion', upload.single('file'), (req, res) => controller.saveAsignacion(req, res));

export default router;
