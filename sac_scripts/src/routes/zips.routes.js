/**
 * routes/zips.routes.js — Endpoints de procesamiento de ZIPs
 *
 *   POST /procesar-zip       → un solo ZIP (multipart/form-data, campo zipFile)
 *   POST /procesar-zips      → lote de ZIPs en base64 (JSON, desde n8n) — SÍNCRONO
 *   GET  /job-status/:jobId  → polling de estado de jobs
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const AdmZip  = require('adm-zip');
const fs      = require('fs');

const config   = require('../config');
const jobStore = require('../services/jobStore');
const { extraerCedulaDePDFs } = require('../services/cedulas');
const { extraerPasswordDelCorreo, procesarLoteZips } = require('../services/zips');
const { correrPuppeteerCedula } = require('../services/puppeteerRunner');
const { mkdirpSync, resolverCarpetaEscritura } = require('../utils/carpetas');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR });

// ─── POST /procesar-zip ───────────────────────────────────────────────────────
router.post('/procesar-zip', upload.single('zipFile'), async (req, res) => {
  const zipPath     = req.file?.path;
  const zipFileName = req.file?.originalname || req.body.zipFileName || 'adjunto.zip';

  const sacUrl  = req.body.sacBaseUrl    || config.SAC_URL;
  const sacUser = req.body.sacUser       || config.SAC_USER;
  const sacPass = req.body.sacPass       || config.SAC_PASS;
  const outBase = req.body.outputBaseDir || config.OUT_DIR;

  if (!zipPath) {
    return res.status(400).json({ success: false, error: 'No se recibió archivo ZIP (campo: zipFile)' });
  }

  try {
    const zip    = new AdmZip(zipPath);
    const cedula = await extraerCedulaDePDFs(zip, zipFileName);

    if (!cedula) {
      fs.unlinkSync(zipPath);
      return res.json({
        success: false,
        error: `No se encontró cédula en los PDFs del ZIP: ${zipFileName}`,
        sugerencia: 'Los PDFs deben contener texto seleccionable con el número de C.C.',
      });
    }

    // Crear carpeta: si ya existe {cedula} usa {cedula}_{año}
    const carpetaSalida = resolverCarpetaEscritura(outBase, cedula);
    mkdirpSync(carpetaSalida);
    zip.extractAllTo(carpetaSalida, true);
    fs.unlinkSync(zipPath);

    // Lanzar el worker Puppeteer (encolado: una sesión SAC a la vez)
    const resultadoPuppeteer = await correrPuppeteerCedula(cedula, carpetaSalida, sacUrl, sacUser, sacPass);

    const archivosFinales = fs.readdirSync(carpetaSalida);

    return res.json({
      success:        resultadoPuppeteer.success,
      cedula,
      carpetaSalida,
      archivosZip:    archivosFinales.filter(f => !f.startsWith('SAC_')),
      pdfsSAC:        archivosFinales.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
      totalArchivos:  archivosFinales.length,
      errorPuppeteer: resultadoPuppeteer.success ? undefined : resultadoPuppeteer.error,
    });

  } catch (err) {
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /procesar-zips (batch, SÍNCRONO) ───────────────────────────────────
// Espera a que Puppeteer termine y responde con { success, clientes }.
// n8n tiene timeout de 20 min (1 200 000 ms) — suficiente para lotes normales.
router.post('/procesar-zips', async (req, res) => {
  const {
    zipsBase64,
    emailBodyText,            // ← cuerpo del correo para extraer contraseña
    zipPassword: reqZipPwd,   // ← contraseña ya extraída (opcional)
    sacPass: reqPass,
  } = req.body;
  const sacUrl  = config.SAC_URL;
  const sacUser = config.SAC_USER;
  const sacPass = reqPass || config.SAC_PASS;
  const outBase = config.OUT_DIR;

  // Determinar contraseña del ZIP:
  // 1. Campo explícito en el body    → reqZipPwd
  // 2. Extraída del cuerpo del email → extraerPasswordDelCorreo
  // 3. Variable de entorno SAC_ZIP_PASS → contraseña por defecto cuando el correo no la trae
  const zipPassword = reqZipPwd
    || extraerPasswordDelCorreo(emailBodyText)
    || config.SAC_ZIP_PASS
    || null;
  if (zipPassword) {
    console.log(`[${new Date().toISOString()}] Contraseña ZIP: "${zipPassword}"`);
  } else {
    console.log(`[${new Date().toISOString()}] Sin contraseña ZIP (ZIPs sin cifrado)`);
  }

  if (!Array.isArray(zipsBase64) || !zipsBase64.length) {
    return res.status(400).json({ success: false, error: 'zipsBase64 debe ser un array no vacío' });
  }

  console.log(`[${new Date().toISOString()}] /procesar-zips: ${zipsBase64.length} ZIPs recibidos`);

  try {
    const resultado = await procesarLoteZips({ zipsBase64, outBase, zipPassword, sacUrl, sacUser, sacPass });
    console.log(`[${new Date().toISOString()}] /procesar-zips completado: ${resultado.clientes?.length ?? 0} cliente(s)`);
    res.json(resultado);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] /procesar-zips error: ${e.message}`);
    res.json({ success: false, error: e.message, clientes: [] });
  }
});

// ─── GET /job-status/:jobId ───────────────────────────────────────────────────
// n8n hace polling aquí cada 60 s hasta que status === 'done' | 'failed'.
router.get('/job-status/:jobId', (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found', error: 'Job no encontrado' });
  return res.json(job);
});

module.exports = router;
