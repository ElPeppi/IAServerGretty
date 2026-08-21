/**
 * routes/garantias.routes.js — Generación de demandas del TRÁMITE DE PAGO DIRECTO
 * (garantía mobiliaria).
 *
 *   POST /generar-garantias → recibe el Excel de la asignación (multipart, campo
 *                             excelFile) y genera la SOLICITUD DE APREHENSIÓN Y
 *                             ENTREGA de cada cliente marcado como pago directo.
 *
 * Es el gemelo de singular.routes.js, pero con menos entradas: aquí no hay
 * cuantía que calcular (no aplica), ni correo de otorgamiento que adjuntar, ni
 * Excel intermedio que devolver. Los datos salen de los documentos que el banco
 * dejó en la carpeta de cada cliente, no del Excel.
 */

'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');

const config = require('../config');
const { procesarGarantias } = require('../services/finandina/garantia');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR });

// Body (multipart/form-data):
//   excelFile      – Excel de la asignación (obligatorio)
//   plantillaPath? – ruta server-side de la plantilla
//   soloCedulas?   – JSON ["123","456"] o "123,456" para regenerar solo esas
router.post('/generar-garantias', upload.single('excelFile'), async (req, res) => {
  const tmpPath = req.file && req.file.path;
  if (!tmpPath) {
    return res.status(400).json({ success: false, error: 'No se recibió el archivo Excel (campo: excelFile)' });
  }

  try {
    const excelBuffer = fs.readFileSync(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch (e) { /* temp, da igual */ }

    let soloCedulas;
    if (req.body.soloCedulas) {
      try { soloCedulas = JSON.parse(req.body.soloCedulas); } catch (e) { soloCedulas = String(req.body.soloCedulas).split(','); }
      soloCedulas = (Array.isArray(soloCedulas) ? soloCedulas : [soloCedulas])
        .map((s) => String(s).trim()).filter(Boolean);
    }

    const resultado = await procesarGarantias(excelBuffer, {
      plantillaPath: req.body.plantillaPath || undefined,
      soloCedulas,
    });
    res.json(resultado);
  } catch (error) {
    console.error(`[/generar-garantias] ${error.message}`);
    try { fs.unlinkSync(tmpPath); } catch (e) { /* ya estaba borrado */ }
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
