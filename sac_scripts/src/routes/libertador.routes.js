/**
 * routes/libertador.routes.js — Poderes de Libertador (individuales por caso)
 *
 *   POST /generar-poder-libertador
 *     Genera UN poder de conciliación a partir de la DECLARACION DE PAGOS de un
 *     caso. El backend baja la declaración de Drive y la manda en base64; el motor
 *     extrae los 6 campos, rellena la plantilla y devuelve el .docx en base64 para
 *     que el backend lo suba a la carpeta del caso.
 *
 *   Body (JSON):
 *     declaracionBase64  (req.)  bytes de la DECLARACION DE PAGOS (.docx o .pdf)
 *     plantillaBase64    (opc.)  plantilla del poder; si falta, se usa la de config
 *     solicitud          (opc.)  solo para el log/traza
 *
 *   Respuesta:
 *     { success, solicitud, campos, faltantes, fuente, nombreArchivo, poderBase64 }
 *     (success:false + error si algo falla — para que el backend siga el lote)
 */
'use strict';

const express = require('express');
const fs = require('fs');

const config = require('../config');
const { generarDesdeBuffers } = require('../services/libertador/poderes');

const router = express.Router();

router.post('/generar-poder-libertador', async (req, res) => {
  const solicitud = String(req.body.solicitud || '').trim() || '(sin solicitud)';
  try {
    if (!req.body.declaracionBase64) {
      return res.status(400).json({ success: false, solicitud, error: 'Falta declaracionBase64' });
    }
    const declBuf = Buffer.from(String(req.body.declaracionBase64), 'base64');

    let plantillaBuf;
    if (req.body.plantillaBase64) {
      plantillaBuf = Buffer.from(String(req.body.plantillaBase64), 'base64');
    } else {
      const p = config.PLANTILLA_PODER_LIBERTADOR_CONCILIACION;
      if (!fs.existsSync(p)) {
        return res.status(400).json({ success: false, solicitud, error: `Plantilla no disponible: ${p}` });
      }
      plantillaBuf = fs.readFileSync(p);
    }

    const r = await generarDesdeBuffers(declBuf, plantillaBuf);
    console.error(`[LIB-PODER] ✓ ${solicitud} → ${r.nombreArchivo}` +
      (r.faltantes.length ? ` (⚠ faltan: ${r.faltantes.join(', ')})` : ''));

    return res.json({
      success: true,
      solicitud,
      campos: r.campos,
      faltantes: r.faltantes,
      fuente: r.fuente,
      nombreArchivo: r.nombreArchivo,
      poderBase64: r.docxBuf.toString('base64'),
    });
  } catch (e) {
    console.error(`[LIB-PODER] ✗ ${solicitud}: ${e.message}`);
    return res.status(500).json({ success: false, solicitud, error: e.message });
  }
});

module.exports = router;
