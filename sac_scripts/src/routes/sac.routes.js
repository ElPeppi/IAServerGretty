/**
 * routes/sac.routes.js — Descarga de obligaciones del SAC por CÉDULA (sin ZIP)
 *
 *   POST /descargar-sac → recibe una lista de cédulas (texto o array) y, por cada
 *                         una, corre el scraping del SAC (Puppeteer) que baja a la
 *                         carpeta del cliente: SAC_{ced}_DIRYTEL.pdf (direcciones),
 *                         SAC_{ced}_OBL{obl}.pdf (obligaciones) y CONTACTOS_{ced}.csv.
 *
 * Reemplaza el disparo por ZIP/n8n: ahora el usuario pega las cédulas (separadas
 * por "-", "," o espacios) o se sacan del Excel de asignación. El resto del flujo
 * (generar la demanda) es igual: lee esos SAC_*.pdf de la carpeta del cliente.
 */

'use strict';

const express = require('express');
const fs      = require('fs');

const config = require('../config');
const { correrPuppeteerCedula } = require('../services/puppeteerRunner');
const { resolverCarpetaLectura, mkdirpSync } = require('../utils/carpetas');

const router = express.Router();

// Cédulas separadas por "-", ",", ";", espacios o saltos de línea → array único, validado.
function parseCedulas(raw) {
  if (Array.isArray(raw)) raw = raw.join(' ');
  return [...new Set(
    String(raw || '')
      .split(/[\s,;\-]+/)
      .map(s => s.replace(/\D/g, '').trim())
      .filter(s => /^\d{5,12}$/.test(s))
  )];
}

// ─── POST /descargar-sac ──────────────────────────────────────────────────────
// Body: { cedulas: "123-456, 789" | ["123","456"], sacUser?, sacPass?, sacBaseUrl?, outputBaseDir? }
router.post('/descargar-sac', async (req, res) => {
  const cedulas = parseCedulas(req.body.cedulas);
  if (!cedulas.length) {
    return res.status(400).json({
      success: false,
      error: 'No se recibieron cédulas válidas (5-12 dígitos). Sepáralas por "-", "," o espacios.',
    });
  }

  const sacUrl  = req.body.sacBaseUrl    || config.SAC_URL;
  const sacUser = req.body.sacUser       || config.SAC_USER;
  const sacPass = req.body.sacPass       || config.SAC_PASS;
  const outBase = req.body.outputBaseDir || config.OUT_DIR;

  console.log(`[${new Date().toISOString()}] /descargar-sac: ${cedulas.length} cédula(s): ${cedulas.join(', ')}`);

  const resultados = [];
  // Secuencial: correrPuppeteerCedula ya encola una sesión SAC a la vez.
  for (const cedula of cedulas) {
    try {
      // Escribe en la carpeta MÁS RECIENTE de la cédula (o crea {cedula}), para que
      // el SAC quede junto a lo que el usuario suba (pagaré, DataCrédito, etc.).
      const carpeta = resolverCarpetaLectura(outBase, cedula);
      mkdirpSync(carpeta);

      const r = await correrPuppeteerCedula(cedula, carpeta, sacUrl, sacUser, sacPass);

      const archivos = fs.existsSync(carpeta) ? fs.readdirSync(carpeta) : [];
      resultados.push({
        cedula,
        success:   !!r.success,
        carpeta,
        pdfsSAC:   archivos.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
        contactos: archivos.find(f => f.startsWith('CONTACTOS_') && f.endsWith('.csv')) || null,
        error:     r.success ? undefined : r.error,
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] /descargar-sac ${cedula}: ${e.message}`);
      resultados.push({ cedula, success: false, error: e.message });
    }
  }

  const ok = resultados.filter(r => r.success).length;
  console.log(`[${new Date().toISOString()}] /descargar-sac completado: ${ok}/${cedulas.length} OK`);
  return res.json({ success: ok > 0, total: cedulas.length, ok, resultados });
});

module.exports = router;
