/**
 * routes/correoPoder.routes.js — Revisa el correo del banco que otorga el poder.
 *
 *   POST /correo-poder/revisar  (multipart, campo "archivo": el PDF)
 *     → { success, estado, paginas, caracteresCuerpo, muestra, fuente, mensaje }
 *
 * El backend la llama ANTES de lanzar una generación: si el PDF elegido no es el
 * correo del banco (p. ej. el Word de los poderes), se rechaza ahí mismo con el
 * motivo, en vez de dejar que salga un ANEXO 1 ilegible en todas las demandas.
 * Si el correo trae el cuerpo sin borrar, NO se rechaza: el motor lo limpia solo
 * al armar el anexo (ver services/comun/correoPoder.js).
 */
'use strict';

const express = require('express');
const multer  = require('multer');

const { analizarCorreoPoder, motivoNoEsCorreo } = require('../services/comun/correoPoder');

const router = express.Router();
// En memoria: es un PDF de una o dos páginas y se analiza en el acto.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.post('/correo-poder/revisar', upload.single('archivo'), async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ success: false, error: 'Falta el PDF (campo: archivo)' });
  }
  try {
    const r = await analizarCorreoPoder(req.file.buffer);
    res.json({
      success: true,
      estado: r.estado,
      paginas: r.paginas,
      caracteresCuerpo: r.caracteresCuerpo,
      muestra: r.muestra,
      fuente: r.fuente,
      mensaje: r.estado === 'no_es_correo' ? motivoNoEsCorreo(r) : undefined,
    });
  } catch (e) {
    console.error(`[correo-poder] ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
