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

// Párrafo con salto de página (separa un poder del siguiente en el doc combinado).
const SALTO_PAGINA = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/**
 * Genera UN SOLO Word con TODOS los poderes de la asignación (uno por cliente,
 * separados por salto de página) — como el consolidado que la oficina arma a mano.
 *
 * items: [{ fila, pagare? }]. `fila` es la fila del Excel de asignación; `pagare`
 * (opcional) sobreescribe el Nº de pagaré del poder («OBLIGACION» de la plantilla):
 *   - con documentos en el servidor → el Nº leído del pagaré/DECEVAL;
 *   - sin ellos → se deja el OBLIGACION del Excel (comportamiento por defecto).
 *
 * Devuelve { buffer, clientes: [{ cedula, nombre, pagare }] } (clientes en orden).
 */
function generarPoderesCombinado(items, templateDocxPath) {
  if (!fs.existsSync(templateDocxPath)) {
    throw new Error(`Plantilla PODER no encontrada: ${templateDocxPath}`);
  }
  const zip = new AdmZip(fs.readFileSync(templateDocxPath));
  const xml = zip.readAsText('word/document.xml');

  // Partir la plantilla: cabecera + contenido del cuerpo (los párrafos del poder)
  // + cola (sectPr del cuerpo + cierre). El contenido se repite por cliente.
  const bodyOpen = xml.indexOf('<w:body>');
  if (bodyOpen < 0) throw new Error('Plantilla PODER sin <w:body>');
  const contentStart = bodyOpen + '<w:body>'.length;
  const sectStart = xml.lastIndexOf('<w:sectPr');
  const head    = xml.slice(0, contentStart);
  const cuerpo  = xml.slice(contentStart, sectStart); // párrafos del poder (plantilla)
  const cola    = xml.slice(sectStart);               // <w:sectPr…></w:body>…

  const clientes = [];
  const bloques  = [];
  for (const item of items) {
    const fila   = item.fila || item;
    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;

    const fieldMap = buildFieldMap(fila);
    // Nº de pagaré del poder: override si el llamador lo resolvió (docs en servidor).
    if (item.pagare != null && String(item.pagare).trim()) {
      fieldMap.OBLIGACION = String(item.pagare).trim();
    }

    let bloque = reemplazarCampos(cuerpo, fieldMap);
    bloque = fixObligacionPlural(bloque, fieldMap);
    bloques.push(bloque);
    clientes.push({
      cedula,
      nombre: String(fila['NOMBRE'] || '').trim(),
      pagare: String(fieldMap.OBLIGACION || '').trim(),
    });
  }

  if (!bloques.length) throw new Error('No hay clientes válidos (columna IDENTIFICACION) para generar poderes');

  const combinado = head + bloques.join(SALTO_PAGINA) + cola;
  zip.updateFile('word/document.xml', Buffer.from(combinado, 'utf8'));
  return { buffer: zip.toBuffer(), clientes };
}

module.exports = { generarPoderes, generarPoderesCombinado };
