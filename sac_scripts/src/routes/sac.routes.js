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
const { notificarBackend } = require('../services/notifier');
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

  // Se responde YA y el scraping sigue en segundo plano: cada cédula tarda entre
  // 1 y 5 minutos, y así el usuario puede ir generando las demandas de la gente
  // cuya info ya bajó, sin esperar a que termine todo el lote. El avance llega
  // por SSE (una notificación por cédula + una final).
  res.status(202).json({
    success: true,
    started: true,
    total: cedulas.length,
    cedulas,
    message: `Descarga del SAC iniciada para ${cedulas.length} cédula(s). Se avisa por cada una que termine.`,
  });

  void descargarEnSegundoPlano({ cedulas, outBase, sacUrl, sacUser, sacPass });
});

// Corre las cédulas en serie (correrPuppeteerCedula ya encola una sesión SAC a la
// vez) y notifica al backend por cada una. Nunca lanza: un fallo de una cédula no
// puede tumbar el lote ni el proceso del motor.
async function descargarEnSegundoPlano({ cedulas, outBase, sacUrl, sacUser, sacPass }) {
  const t0 = Date.now();
  const resultados = [];

  await notificarBackend({
    type: 'sac',
    level: 'info',
    title: 'Descarga del SAC iniciada',
    message: `Bajando la información de ${cedulas.length} persona(s)…`,
    meta: { fase: 'inicio', total: cedulas.length, cedulas },
  });

  for (const cedula of cedulas) {
    let item;
    try {
      // Escribe en la carpeta MÁS RECIENTE de la cédula (o crea {cedula}), para que
      // el SAC quede junto a lo que el usuario suba (pagaré, DataCrédito, etc.).
      const carpeta = resolverCarpetaLectura(outBase, cedula);
      mkdirpSync(carpeta);

      const r = await correrPuppeteerCedula(cedula, carpeta, sacUrl, sacUser, sacPass);

      const archivos = fs.existsSync(carpeta) ? fs.readdirSync(carpeta) : [];
      item = {
        cedula,
        success:   !!r.success,
        carpeta,
        pdfsSAC:   archivos.filter(f => f.startsWith('SAC_') && f.endsWith('.pdf')),
        contactos: archivos.find(f => f.startsWith('CONTACTOS_') && f.endsWith('.csv')) || null,
        error:     r.success ? undefined : r.error,
      };
    } catch (e) {
      console.error(`[${new Date().toISOString()}] /descargar-sac ${cedula}: ${e.message}`);
      item = { cedula, success: false, error: e.message };
    }

    resultados.push(item);

    // Aviso por PERSONA: es lo que permite ir generando su demanda de una.
    await notificarBackend({
      type: 'sac',
      level: item.success ? 'success' : 'warning',
      title: item.success ? `SAC listo: ${cedula}` : `SAC falló: ${cedula}`,
      message: item.success
        ? `${(item.pdfsSAC || []).length} PDF(s) descargado(s). Ya puedes generar su demanda.`
        : `No se pudo bajar la información: ${item.error || 'motivo desconocido'}`,
      meta: {
        fase: 'cedula',
        cedula,
        success: item.success,
        pdfs: (item.pdfsSAC || []).length,
        hechas: resultados.length,
        total: cedulas.length,
      },
    });
  }

  const ok = resultados.filter(r => r.success).length;
  const segs = Math.round((Date.now() - t0) / 1000);
  console.log(`[${new Date().toISOString()}] /descargar-sac completado: ${ok}/${cedulas.length} OK en ${segs}s`);

  await notificarBackend({
    type: 'sac',
    level: ok === cedulas.length ? 'success' : (ok ? 'warning' : 'error'),
    title: 'Descarga del SAC terminada',
    message: `${ok} de ${cedulas.length} persona(s) con información descargada.`,
    meta: {
      fase: 'fin',
      ok,
      total: cedulas.length,
      segundos: segs,
      fallidas: resultados.filter(r => !r.success).map(r => r.cedula),
    },
  });
}

module.exports = router;
