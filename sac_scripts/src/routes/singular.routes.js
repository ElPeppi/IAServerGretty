/**
 * routes/singular.routes.js — Endpoint de generación de Plantilla Singular
 *
 *   POST /generar-singular → recibe Excel de entrada (multipart, campo excelFile),
 *                            llena la Plantilla Singular + demandas Word y
 *                            devuelve JSON con el XLSX en base64.
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');

const config = require('../config');
const { procesarSingular } = require('../services/singular');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR });

// Body (multipart/form-data):
//   excelFile        – archivo Excel obligatorio
//   plantillaPath?   – ruta server-side de la plantilla (default: config.PLANTILLA_SINGULAR)
//   fechaAsignacion? – DD/MM/YYYY (default: hoy)
router.post('/generar-singular', upload.single('excelFile'), async (req, res) => {
  const tmpPath = req.file?.path;

  if (!tmpPath) {
    return res.status(400).json({ success: false, error: 'No se recibió el archivo Excel (campo: excelFile)' });
  }

  try {
    const excelBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);  // limpiar temp inmediatamente

    const plantillaPath   = req.body.plantillaPath   || undefined;
    const fechaAsignacion = req.body.fechaAsignacion || undefined;

    console.log(`[${new Date().toISOString()}] /generar-singular: procesando Excel...`);

    const result = await procesarSingular(excelBuffer, {
      sacDocsDir:    config.OUT_DIR,
      plantillaPath,
      // demandaTemplate se toma automáticamente de PLANTILLA_DEMANDA en el .env
      fechaAsignacion,
    });

    if (!result.success || !result.xlsxBuffer) {
      return res.status(result.error ? 422 : 500).json({
        success:  false,
        error:    result.error || 'Error desconocido',
        clientes: result.clientes || [],
        errores:  result.errores  || [],
      });
    }

    console.log(`[${new Date().toISOString()}] /generar-singular: OK — ${result.totalFilas} fila(s), ${result.demandas?.length || 0} demanda(s) Word`);

    // Devolver JSON con base64 para fácil consumo desde n8n
    return res.json({
      success:    true,
      totalFilas: result.totalFilas,
      clientes:   result.clientes,
      errores:    result.errores,
      demandas:   result.demandas?.map(d => ({ cedula: d.cedula, archivo: d.path })) || [],
      xlsxBase64: result.xlsxBuffer.toString('base64'),
    });

  } catch (err) {
    if (tmpPath && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    console.error(`[${new Date().toISOString()}] /generar-singular ERROR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
