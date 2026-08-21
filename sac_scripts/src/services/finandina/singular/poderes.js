/**
 * services/finandina/singular/poderes.js — Genera el PODER por cliente
 *
 * Usa la plantilla PLANTILLA PODER SINGULAR AI.docx (marcadores «CAMPO») y la
 * misma fila/datos con que se generó la demanda. El poder es un llenado simple
 * de placeholders (sin secciones condicionales). Se guarda en la carpeta del
 * cliente, junto a la demanda.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');

const { resolverCarpetaCedula } = require('../../../utils/carpetas');
const { fillPoder } = require('../../comun/poderes');
const { buildFieldMap } = require('./demandas');

/**
 * Genera un PODER .docx por cliente a partir de los mismos items de la demanda.
 * items: [{ fila, ... }] (se usa solo la fila).
 * Devuelve [{ cedula, path }] de los poderes generados.
 */
async function generarPoderes(items, sacDocsDir, templateDocxPath) {
  if (!fs.existsSync(templateDocxPath)) {
    throw new Error(`Plantilla PODER no encontrada: ${templateDocxPath}`);
  }
  const templateBuf = fs.readFileSync(templateDocxPath);
  const generados   = [];

  for (const item of items) {
    const fila = item.fila || item;
    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    try {
      const fieldMap  = buildFieldMap(fila);   // los 6 campos del poder van incluidos
      const docxBuf   = fillPoder(templateBuf, fieldMap);
      const clientDir = resolverCarpetaCedula(sacDocsDir, cedula);
      if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
      const nombre  = (fila['NOMBRE'] || cedula).trim().replace(/[<>:"/\\|?*]/g, '_');
      const outFile = path.join(clientDir, `PODER SINGULAR ${nombre} - ${cedula}.docx`);
      fs.writeFileSync(outFile, docxBuf);
      generados.push({ cedula, path: outFile });
      console.error(`[PODER] ✓ ${cedula} → ${path.basename(outFile)}`);
    } catch (e) {
      console.error(`[PODER] ✗ ${cedula}: ${e.message}`);
    }
  }
  return generados;
}

// Concordancia singular/plural sobre un fragmento ya lleno (misma regla que fillPoder).
function fixObligacionPlural(xml, fieldMap) {
  const numObls = String(fieldMap.OBLIGACIONES || '').split(',').filter(s => s.trim()).length;
  if (numObls > 1) {
    xml = xml.replace(
      /respalda la((?:\s|<[^>]+>)*?)([Oo]bligaci)ón/g,
      (m, between, oblig) => `respalda las${between}${oblig}ones`
    );
  }
  return xml;
}

// ─── Constructores de campos por tipo de poder ───────────────────────────────
// Cada uno recibe un item y devuelve { fieldMap, cliente } — o null si le faltan
// los datos mínimos. `cliente` es lo que se le reporta a la web.

/** PODER EJECUTIVO SINGULAR: los 6 marcadores de la plantilla de siempre. */
function camposSingular(item) {
  const fila   = item.fila || item;
  const cedula = String(fila['IDENTIFICACION'] || '').trim();
  if (!cedula) return null;

  const fieldMap = buildFieldMap(fila);
  // Nº de pagaré del poder: override si el llamador lo resolvió (docs en servidor).
  if (item.pagare != null && String(item.pagare).trim()) {
    fieldMap.OBLIGACION = String(item.pagare).trim();
  }
  return {
    fieldMap,
    cliente: {
      cedula,
      nombre: String(fila['NOMBRE'] || '').trim(),
      pagare: String(fieldMap.OBLIGACION || '').trim(),
    },
  };
}

module.exports = {
  generarPoderes,
  camposSingular,
  fixObligacionPlural,
};
