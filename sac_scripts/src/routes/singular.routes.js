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
//   correoPoder      – correo PDF del banco (opcional) para el ANEXO 1; el mismo
//                      correo se usa para todo el lote
//   plantillaPath?   – ruta server-side de la plantilla (default: config.PLANTILLA_SINGULAR)
//   fechaAsignacion? – DD/MM/YYYY (default: hoy)
router.post('/generar-singular',
  upload.fields([{ name: 'excelFile', maxCount: 1 }, { name: 'correoPoder', maxCount: 1 }]),
  async (req, res) => {
  const tmpPath    = req.files?.excelFile?.[0]?.path;
  const correoPath = req.files?.correoPoder?.[0]?.path;

  if (!tmpPath) {
    return res.status(400).json({ success: false, error: 'No se recibió el archivo Excel (campo: excelFile)' });
  }

  try {
    const excelBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);  // limpiar temp inmediatamente

    let correoPoderBuffer = null;
    if (correoPath) {
      correoPoderBuffer = fs.readFileSync(correoPath);
      try { fs.unlinkSync(correoPath); } catch (_) {}
    }

    const plantillaPath   = req.body.plantillaPath   || undefined;
    const fechaAsignacion = req.body.fechaAsignacion || undefined;
    const smmv            = req.body.smmv ? Number(req.body.smmv) : undefined; // salario mínimo (umbrales de cuantía)
    let transito = undefined; // directorio de tránsito [{ciudad,entidad,correo}] (JSON)
    if (req.body.transito) { try { transito = JSON.parse(req.body.transito); } catch { transito = undefined; } }

    console.log(`[${new Date().toISOString()}] /generar-singular: procesando Excel${correoPoderBuffer ? ' (con correo poder)' : ''}...`);

    const result = await procesarSingular(excelBuffer, {
      sacDocsDir:    config.OUT_DIR,
      plantillaPath,
      // demandaTemplate se toma automáticamente de PLANTILLA_DEMANDA en el .env
      fechaAsignacion,
      correoPoderBuffer,
      smmv,
      transito,
    });

    if (!result.success || !result.xlsxBuffer) {
      return res.status(result.error ? 422 : 500).json({
        success:    false,
        error:      result.error || 'Error desconocido',
        totalFilas: result.totalFilas || 0,
        clientes:   result.clientes || [],
        omitidos:   result.omitidos || [],   // por qué no se generó cada uno
        errores:    result.errores  || [],
      });
    }

    console.log(`[${new Date().toISOString()}] /generar-singular: OK — ${result.totalFilas} fila(s), ${result.demandas?.length || 0} demanda(s) Word`);

    // Devolver JSON con base64 para fácil consumo desde n8n / backend.
    // `documentos` trae, por cliente, los archivos generados (base64) + notas,
    // para que el backend los persista (demanda, anexos, antecedentes).
    return res.json({
      success:    true,
      totalFilas: result.totalFilas,
      clientes:   result.clientes,
      documentos: result.documentos || [],
      omitidos:   result.omitidos || [],
      errores:    result.errores,
      demandas:   result.demandas?.map(d => ({ cedula: d.cedula, archivo: d.path })) || [],
      xlsxBase64: result.xlsxBuffer.toString('base64'),
    });

  } catch (err) {
    for (const p of [tmpPath, correoPath]) {
      if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    console.error(`[${new Date().toISOString()}] /generar-singular ERROR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
