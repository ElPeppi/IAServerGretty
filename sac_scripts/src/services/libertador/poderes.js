/**
 * services/libertador/poderes.js — Poder de Conciliación de Libertador
 *
 * A diferencia de Finandina (un solo Word combinado con todos los poderes), en
 * Libertador cada caso/demandado genera un **Word INDIVIDUAL** que se guarda en
 * **su propia carpeta** (la del caso: DEMANDAS/LIBERTADOR/SINGULAR/<solicitud>).
 *
 * Fuente de datos: la DECLARACION DE PAGOS del caso (ver declaracionPagos.js).
 * Plantilla: PLANTILLA PODER DE CONCILIACION.docx (marcadores MERGEFIELD «...»).
 *
 * Flujo por caso:
 *   carpeta del caso → encontrar DECLARACION DE PAGOS → extraer 6 campos →
 *   rellenar la plantilla → escribir "PODER DE CONCILIACION ....docx" en la carpeta.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { fillPoder } = require('../comun/poderes');
const { extraerDeArchivo, extraerDeBuffer, aFieldMapPoder } = require('./declaracionPagos');

// Nombre del archivo del poder generado (dentro de la carpeta del caso).
function nombreArchivoPoder(campos) {
  const sol = String(campos.solicitud || 's_sol').trim();
  const inmob = String(campos.inmobiliaria || '')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/[.\s]+$/, '').trim();
  return `PODER DE CONCILIACION - ${sol}${inmob ? ' - ' + inmob : ''}.docx`;
}

// Encuentra la DECLARACION DE PAGOS dentro de una carpeta (excluye otras
// "declaraciones", p. ej. "DECLARACIÓN GOMEZ ..."). Prefiere .docx sobre .pdf.
function encontrarDeclaracion(carpetaCaso) {
  const files = fs.readdirSync(carpetaCaso)
    .filter((f) => /declaraci.*pago/i.test(f));
  if (!files.length) return null;
  files.sort((a, b) => (/\.docx$/i.test(b) ? 1 : 0) - (/\.docx$/i.test(a) ? 1 : 0));
  return path.join(carpetaCaso, files[0]);
}

/**
 * Genera el Buffer del poder de conciliación (un docx) a partir de los campos.
 * plantillaBuf: Buffer de PLANTILLA PODER DE CONCILIACION.docx
 */
function generarPoderConciliacion(campos, plantillaBuf) {
  return fillPoder(plantillaBuf, aFieldMapPoder(campos));
}

/**
 * Procesa la carpeta de UN caso: busca la declaración, extrae, genera el poder y
 * lo guarda en la MISMA carpeta. Devuelve un objeto resultado (no lanza).
 *
 *   { success, carpeta, declaracion, archivo?, campos?, faltantes?, fuente?, error? }
 */
async function procesarCarpetaCaso(carpetaCaso, plantillaPath) {
  const out = { success: false, carpeta: carpetaCaso };
  try {
    if (!fs.existsSync(plantillaPath)) throw new Error(`Plantilla no encontrada: ${plantillaPath}`);
    const declPath = encontrarDeclaracion(carpetaCaso);
    if (!declPath) throw new Error('No se encontró DECLARACION DE PAGOS en la carpeta');
    out.declaracion = path.basename(declPath);

    const campos = await extraerDeArchivo(declPath);
    out.campos = campos;
    out.fuente = campos.fuente;
    out.faltantes = campos.faltantes;

    const plantillaBuf = fs.readFileSync(plantillaPath);
    const docxBuf = generarPoderConciliacion(campos, plantillaBuf);

    const archivo = path.join(carpetaCaso, nombreArchivoPoder(campos));
    fs.writeFileSync(archivo, docxBuf);
    out.archivo = archivo;
    out.success = true;
    console.error(`[LIB-PODER] ✓ ${path.basename(carpetaCaso)} → ${path.basename(archivo)}` +
      (campos.faltantes.length ? ` (⚠ faltan: ${campos.faltantes.join(', ')})` : ''));
  } catch (e) {
    out.error = e.message;
    console.error(`[LIB-PODER] ✗ ${path.basename(carpetaCaso)}: ${e.message}`);
  }
  return out;
}

/**
 * Genera el poder desde buffers (para el endpoint del motor: el backend baja la
 * DECLARACION DE PAGOS de Drive y la manda en base64; la plantilla igual).
 * Devuelve { campos, faltantes, fuente, docxBuf, nombreArchivo }.
 */
async function generarDesdeBuffers(declaracionBuf, plantillaBuf) {
  const campos = await extraerDeBuffer(declaracionBuf);
  const docxBuf = generarPoderConciliacion(campos, plantillaBuf);
  return {
    campos,
    faltantes: campos.faltantes,
    fuente: campos.fuente,
    docxBuf,
    nombreArchivo: nombreArchivoPoder(campos),
  };
}

module.exports = {
  nombreArchivoPoder,
  encontrarDeclaracion,
  generarPoderConciliacion,
  procesarCarpetaCaso,
  generarDesdeBuffers,
};
