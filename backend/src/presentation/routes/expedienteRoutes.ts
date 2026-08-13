import { Router } from 'express';
import { ExpedienteController } from '../controllers/ExpedienteController';
import { authenticate } from '../middlewares/authMiddleware';

const router = Router();
const controller = new ExpedienteController();

router.use(authenticate);

// Correos de otorgamiento del poder ya guardados (ANEXO 1). Va ANTES de
// `/:cedula` para que no lo capture esa ruta.
router.get('/_correos-poder', (req, res) => controller.correosPoder(req, res));
// Datos del pagaré que el OCR no puede leer y se capturan a mano. Van ANTES de
// `/:cedula` por el mismo motivo.
router.get('/:cedula/datos-manuales', (req, res) => controller.verDatosManuales(req, res));
router.put('/:cedula/datos-manuales', (req, res) => controller.guardarDatosManuales(req, res));
// Documentos que tiene un cliente en el servidor (SAC, pagaré, demanda…).
router.get('/:cedula', (req, res) => controller.ver(req, res));
// Borrado real (el backend actúa como la cuenta dueña de los archivos).
router.delete('/:cedula/archivo', (req, res) => controller.borrarArchivo(req, res));

export default router;
