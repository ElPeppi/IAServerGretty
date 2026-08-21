/**
 * services/finandina/singular/antecedentes.js — Genera ANTECEDENTES.pdf por cliente
 *
 * Une, en un solo PDF llamado ANTECEDENTES.pdf:
 *   1. El PDF de direcciones del SAC   → SAC_{cedula}_DIRYTEL.pdf
 *   2. Los PDF de obligaciones del SAC → SAC_{cedula}_OBL*.pdf (todas)
 *
 * Se guarda en la carpeta del cliente, junto a la demanda.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { PDFDocument } = require('pdf-lib');

const { resolverCarpetaCedula } = require('../../../utils/carpetas');

// Copia todas las páginas de `srcBytes` dentro del documento `out`.
async function anexarPdf(out, srcBytes) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const paginas = await out.copyPages(src, src.getPageIndices());
  paginas.forEach(p => out.addPage(p));
}

/**
 * Genera {carpeta}/ANTECEDENTES.pdf uniendo direcciones + obligaciones.
 * Devuelve la ruta del PDF generado, o '' si no había PDFs que unir.
 */
async function generarAntecedentes(cedula, sacDocsDir) {
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return '';

  const archivos = fs.readdirSync(dir);
  // Direcciones primero, luego obligaciones (ordenadas por nombre)
  const dirytel = archivos.filter(f => /^SAC_.*DIRYTEL\.pdf$/i.test(f)).sort();
  const obls    = archivos.filter(f => /^SAC_.*OBL.*\.pdf$/i.test(f)).sort();
  const orden   = [...dirytel, ...obls];

  if (orden.length === 0) {
    console.error(`[ANTECEDENTES] ${cedula}: sin PDFs SAC (DIRYTEL/OBL) para unir`);
    return '';
  }

  try {
    const out = await PDFDocument.create();
    for (const nombre of orden) {
      try {
        await anexarPdf(out, fs.readFileSync(path.join(dir, nombre)));
      } catch (e) {
        console.error(`[ANTECEDENTES] ${cedula}: no se pudo anexar ${nombre}: ${e.message}`);
      }
    }
    if (out.getPageCount() === 0) return '';

    const outPath = path.join(dir, 'ANTECEDENTES.pdf');
    fs.writeFileSync(outPath, await out.save());
    console.error(`[ANTECEDENTES] ✓ ${cedula}: ${out.getPageCount()} página(s) (${orden.length} PDF) → ANTECEDENTES.pdf`);
    return outPath;
  } catch (e) {
    console.error(`[ANTECEDENTES] ${cedula}: ${e.message}`);
    return '';
  }
}

module.exports = { generarAntecedentes };
