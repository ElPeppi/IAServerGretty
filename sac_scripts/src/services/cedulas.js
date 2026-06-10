/**
 * services/cedulas.js — Extracción de cédula colombiana desde ZIPs de documentos
 *
 * Estrategia en 3 intentos:
 *   1. Texto de los PDFs del ZIP (DATACREDITO primero, cadena de patrones por prioridad)
 *   2. Nombre de los PDFs (número standalone o sufijo de número DECEVAL largo)
 *   3. Nombre del archivo ZIP
 */

'use strict';

const path     = require('path');
const pdfParse = require('pdf-parse');

// ─── Patrones cédula colombiana (en orden de prioridad de la cadena) ─────────
const CEDULA_DATACREDITO_RE    = /N[uú]mero\s+Documento\s+(\d{6,11})/i;
// DECEVAL / pagaré: el deudor aparece como OTORGANTE con tipo CC.
// Ej: "635844 OTORGANTE FENNER BERMUDEZ SANCHEZ CC 83089336"
// Se busca OTORGANTE seguido de texto hasta CC (con o sin espacio) y el número.
const CEDULA_DECEVAL_RE        = /OTORGANTE[\s\S]{1,150}?CC\s*(\d{6,12})/i;
// "CC" standalone seguido del número (con o sin espacio entre ellos)
const CEDULA_CC_TIPO_RE        = /\bCC\s*(\d{6,12})\b/;
const CEDULA_CC_RE             = /C\.?\s*C\.?[\s\S]{0,80}?(\d{6,11})/;
const CEDULA_TEXTO_RE          = /[Cc][eé]dula\s*(?:de\s*[Cc]iudadan[ií]a)?\s*[:#Nn°\.]?\s*(\d{6,11})/i;
const CEDULA_SOLO_RE           = /\b(\d{6,11})\b/;
const CEDULA_NUM_DOC_RE        = /N[uú]mero\s+(?:de\s+)?[Dd]ocumento\s*[:\-]?\s*(\d{6,12})/i;
const CEDULA_IDENTIFICACION_RE = /[Ii]dentificaci[oó]n\s*[:\-]?\s*(\d{6,12})/i;

function limpiarNumero(str) { return str.replace(/[\s.]/g, ''); }

// ─── Extrae cédula de los PDFs del ZIP (con soporte de contraseña) ────────────
async function extraerCedulaDePDFs(zip, zipFileName, password) {
  const entries    = zip.getEntries();
  const pdfEntries = entries
    .filter(e => e.entryName.toLowerCase().endsWith('.pdf') && !e.isDirectory)
    // Procesar DATACREDITO primero: tiene la cédula en formato claro.
    // Los pagarés DECEVAL tienen múltiples números que confunden los regex genéricos.
    .sort((a, b) => {
      const score = e => /DATACREDITO/i.test(e.entryName) ? 0 : 1;
      return score(a) - score(b);
    });

  console.log(`[DEBUG] ZIP "${zipFileName || '?'}": ${entries.length} entradas, ${pdfEntries.length} PDFs${password ? ' [cifrado]' : ''}`);
  pdfEntries.forEach(e => console.log(`[DEBUG]   PDF: ${e.entryName} (${e.header.size} bytes)`));

  // Capturar nombres ANTES de Intento 1 — getData() para ZIPs AES puede
  // corromper los entry objects, lo que haría fallar path.basename en Intento 2.
  const pdfNames = pdfEntries.map(e => e.entryName);

  // Intento 1: texto dentro de cada PDF (descifrando con la contraseña si aplica)
  for (const entry of pdfEntries) {
    try {
      const buffer = password ? entry.getData(password) : entry.getData();
      console.log(`[DEBUG]   Parseando PDF: ${entry.entryName} (${buffer.length} bytes)`);
      const parsed = await pdfParse(buffer, { max: 5 });
      const texto  = (parsed.text || '').replace(/\s+/g, ' ').trim();
      console.log(`[DEBUG]   Texto PDF (300 chars): ${texto.slice(0, 300)}`);

      const mND  = texto.match(CEDULA_NUM_DOC_RE);        if (mND)  { console.log(`[DEBUG]   Cédula NUM_DOC: ${mND[1]}`);          return limpiarNumero(mND[1]); }
      const mDC  = texto.match(CEDULA_DATACREDITO_RE);    if (mDC)  { console.log(`[DEBUG]   Cédula DATACREDITO: ${mDC[1]}`);      return limpiarNumero(mDC[1]); }
      const mID  = texto.match(CEDULA_IDENTIFICACION_RE); if (mID)  { console.log(`[DEBUG]   Cédula IDENTIFICACION: ${mID[1]}`);   return limpiarNumero(mID[1]); }
      // DECEVAL pagaré: OTORGANTE con tipo CC (más específico que el regex genérico)
      const mDEV = texto.match(CEDULA_DECEVAL_RE);        if (mDEV) { console.log(`[DEBUG]   Cédula DECEVAL OTORGANTE: ${mDEV[1]}`); return limpiarNumero(mDEV[1]); }
      // CC standalone seguido del número (con o sin espacio)
      const mCCT = texto.match(CEDULA_CC_TIPO_RE);        if (mCCT) { console.log(`[DEBUG]   Cédula CC tipo: ${mCCT[1]}`);         return limpiarNumero(mCCT[1]); }
      const mCC  = texto.match(CEDULA_CC_RE);              if (mCC)  { console.log(`[DEBUG]   Cédula CC: ${mCC[1]}`);               return limpiarNumero(mCC[1]); }
      const mTx  = texto.match(CEDULA_TEXTO_RE);           if (mTx)  { console.log(`[DEBUG]   Cédula TEXTO: ${mTx[1]}`);            return limpiarNumero(mTx[1]); }
      const mS   = texto.match(CEDULA_SOLO_RE);            if (mS)   { console.log(`[DEBUG]   Cédula SOLO: ${mS[1]}`);              return mS[1]; }
      console.log(`[DEBUG]   Sin cédula en texto del PDF`);
    } catch (e) {
      // Si falla con password, intentar sin contraseña (ZIP no cifrado)
      if (password) {
        try {
          const buffer = entry.getData();
          const parsed = await pdfParse(buffer, { max: 5 });
          const texto  = (parsed.text || '').replace(/\s+/g, ' ').trim();
          const mS = texto.match(CEDULA_SOLO_RE);
          if (mS) { console.log(`[DEBUG]   Cédula (sin pwd): ${mS[1]}`); return mS[1]; }
        } catch (_) {}
      }
      console.warn(`[DEBUG]   pdfParse ERROR ${entry.entryName}: ${e.message}`);
    }
  }

  // Intento 2: nombre del PDF dentro del ZIP (usa pdfNames capturado antes de Intento 1)
  // A: número standalone de 6-12 dígitos.
  // B: los últimos N dígitos de un número más largo (ej: "4533197914983089336" → "83089336").
  //    Los números DECEVAL suelen terminar en la cédula del titular.
  console.log(`[DEBUG]   Intento 2: buscando cédula en ${pdfNames.length} nombre(s) de PDF`);
  for (const entryName of pdfNames) {
    const nombre  = path.basename(entryName).replace(/[.]pdf.*/i, '');
    console.log(`[DEBUG]   Nombre limpio: "${nombre}"`);
    const numSeqs = nombre.match(/\d{6,}/g) || [];
    for (const ns of numSeqs) {
      // A: standalone 6-12 dígitos
      if (ns.length <= 12) {
        console.log(`[DEBUG]   Cédula del nombre PDF (A): ${ns}`);
        return ns;
      }
      // B: número largo → probar sufijos de 8, 9, 10, 11 dígitos
      for (const len of [8, 9, 10, 11]) {
        const suf = ns.slice(-len);
        if (/^[1-9]/.test(suf)) {
          console.log(`[DEBUG]   Cédula del nombre PDF (B, sufijo ${len}): ${suf}`);
          return suf;
        }
      }
    }
  }

  // Intento 3: nombre del archivo ZIP
  if (zipFileName) {
    const baseName = path.basename(zipFileName, '.zip');
    const m = baseName.match(/\b(\d{6,12})\b/);
    if (m) { console.log(`[DEBUG]   Cédula del nombre ZIP: ${m[1]}`); return m[1]; }
  }

  return null;
}

module.exports = { extraerCedulaDePDFs };
