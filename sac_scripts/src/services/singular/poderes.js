/**
 * services/singular/poderes.js — Genera el PODER por cliente
 *
 * Usa la plantilla PLANTILLA PODER SINGULAR AI.docx (marcadores «CAMPO») y la
 * misma fila/datos con que se generó la demanda. El poder es un llenado simple
 * de placeholders (sin secciones condicionales). Se guarda en la carpeta del
 * cliente, junto a la demanda.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const AdmZip = require('adm-zip');

const { resolverCarpetaCedula } = require('../../utils/carpetas');
const { buildFieldMap, reemplazarCampos } = require('./demandas');

function fillPoder(templateBuffer, fieldMap) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');
  xml = reemplazarCampos(xml, fieldMap);

  // Concordancia singular/plural (igual que la demanda): con más de una
  // obligación, "respalda la Obligación" → "respalda las Obligaciones".
  const numObls = String(fieldMap.OBLIGACIONES || '').split(',').filter(s => s.trim()).length;
  if (numObls > 1) {
    xml = xml.replace(
      /respalda la((?:\s|<[^>]+>)*?)([Oo]bligaci)ón/g,
      (m, between, oblig) => `respalda las${between}${oblig}ones`
    );
  }

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

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

module.exports = { generarPoderes };
