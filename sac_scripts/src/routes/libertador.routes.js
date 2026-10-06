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
const path = require('path');

const config = require('../config');
const { generarDesdeBuffers } = require('../services/libertador/poderes');
const { procesarSolicitudes } = require('../../libertador_puppeteer');

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

/**
 * POST /estados-cuenta-libertador
 *   Entra al portal (AgentWeb) y, por cada nº de solicitud, abre el siniestro
 *   Vigente o Desocupado y su pestaña "Estado de Cuenta".
 *
 *   Body: { solicitudes: string[] }
 *   Respuesta: { success, total, ok, resultados: [{ solicitud, success, omitido?, motivo?, ... }] }
 *
 *   Un caso sin siniestro Vigente ni Desocupado NO es un error: viene con `omitido:true` y su
 *   motivo, para que el backend lo notifique y siga con el resto del lote.
 *
 *   PENDIENTE: la lectura de los datos del Estado de Cuenta (`datos` llega null).
 *   Falta mapear ese datagrid al contrato de `generarEstadoCuenta`.
 */
router.post('/estados-cuenta-libertador', async (req, res) => {
  const solicitudes = Array.isArray(req.body.solicitudes)
    ? req.body.solicitudes
    : String(req.body.solicitudes || '').split(/[\s,;-]+/);
  const lista = solicitudes.map((x) => String(x || '').trim()).filter(Boolean);

  if (!lista.length) {
    return res.status(400).json({ success: false, error: 'No se recibió ninguna solicitud (campo: solicitudes).' });
  }

  console.error(`[LIB-ESTCTA] ${lista.length} solicitud(es): ${lista.join(', ')}`);

  // La plantilla viaja desde el backend (es quien habla con Drive). Se deja en
  // un temporal porque el escritor trabaja contra un archivo, no un buffer.
  let plantillaPath = null;
  let temporal = null;
  if (req.body.plantillaBase64) {
    temporal = path.join(config.TEMP_DIR, `plantilla_estado_cuenta_${Date.now()}.xls`);
    fs.mkdirSync(config.TEMP_DIR, { recursive: true });
    fs.writeFileSync(temporal, Buffer.from(String(req.body.plantillaBase64), 'base64'));
    plantillaPath = temporal;
  } else {
    console.error('[LIB-ESTCTA] sin plantilla: se devolverán los datos sin armar el Excel');
  }

  try {
    const resultados = await procesarSolicitudes(lista, { plantillaPath, elaboro: req.body.elaboro });
    const ok = resultados.filter((r) => r.success).length;
    console.error(`[LIB-ESTCTA] ✓ ${ok}/${lista.length}`);
    return res.json({ success: true, total: lista.length, ok, resultados });
  } catch (e) {
    // Fallo global (no se pudo ni abrir sesión): el lote entero no corrió.
    console.error(`[LIB-ESTCTA] ERROR global: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message, total: lista.length, ok: 0, resultados: [] });
  } finally {
    if (temporal) { try { fs.unlinkSync(temporal); } catch { /* da igual */ } }
  }
});

module.exports = router;
