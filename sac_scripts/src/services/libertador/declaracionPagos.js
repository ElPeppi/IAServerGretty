/**
 * services/libertador/declaracionPagos.js
 *
 * Extrae los 6 campos del PODER DE CONCILIACIÓN de Libertador desde el documento
 * "DECLARACION DE PAGOS" del caso (Drive: DEMANDAS/LIBERTADOR/SINGULAR/<sol>).
 *
 * La declaración es un texto de formato ESTABLE (verificado en varios casos):
 *   «póliza» - «solicitud»
 *   DECLARACIÓN DE PAGO Y SUBROGACIÓN DE UNA OBLIGACIÓN
 *   «REPRESENTANTE», mayor de edad, ... obrando como representante legal de
 *   «INMOBILIARIA», ... inmueble: «DIRECCION» ciudad «CIUDAD» ...
 *   ... los siguientes arrendatarios «ARRENDATARIOS».
 *   ... (firma) «REPRESENTANTE»  C.C./C.e. No. «IDENTIFICACION»  «INMOBILIARIA»  NIT ...
 *
 * Formatos de archivo: .docx (digital) o .pdf. Los PDF pueden ser DIGITALES o
 * ESCANEADOS: casi todos los escaneados ya traen capa de texto (CamScanner), que
 * leemos directo; si un PDF NO trae capa de texto, se hace fallback a OCR
 * (Tesseract por defecto; Google Vision si OCR_MOTOR=vision) vía services/ocr.js.
 *
 * OJO: la capa de texto de escaneos puede traer ruido (p. ej. "C.e.NO." por
 * "C.C. No."), por eso los patrones son tolerantes. Conviene mostrar los valores
 * extraídos al abogado para revisión.
 */
'use strict';

const fs = require('fs');
const AdmZip = require('adm-zip');
const pdfParse = require('pdf-parse');

// Colapsa espacios/no-break spaces a un solo espacio.
const norm = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// XML de word/document.xml → texto plano.
function xmlATexto(xml) {
  // Los </w:p> marcan fin de párrafo: se vuelven espacio para no pegar palabras.
  return norm(xml.replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, ''));
}

// Solo dígitos (para cédulas/NIT que vienen con puntos/comas de miles).
const soloDigitos = (s) => String(s || '').replace(/[^\d]/g, '');

/**
 * Lee el texto de una DECLARACION DE PAGOS (.docx o .pdf). Si el PDF no trae capa
 * de texto, cae a OCR. Devuelve { texto, fuente }.
 *   fuente: 'docx' | 'pdf-texto' | 'ocr:tesseract' | 'ocr:vision'
 */
async function leerTextoDeBuffer(buf) {
  const sig = buf.slice(0, 4).toString('hex');

  if (sig === '504b0304') { // ZIP → .docx
    const entry = new AdmZip(buf).getEntry('word/document.xml');
    if (!entry) throw new Error('docx sin word/document.xml');
    return { texto: xmlATexto(entry.getData().toString('utf8')), fuente: 'docx' };
  }

  if (buf.slice(0, 5).toString('latin1') === '%PDF-') { // .pdf
    const t = norm((await pdfParse(buf)).text || '');
    if (t.replace(/\s+/g, '').length >= 40) return { texto: t, fuente: 'pdf-texto' };
    // Sin capa de texto → OCR (Tesseract por defecto; Vision si OCR_MOTOR=vision)
    const { ocrPdf } = require('../ocr');
    const r = await ocrPdf(buf, { scale: 3, maxPages: 3 });
    return { texto: norm(r.text || ''), fuente: `ocr:${r.motor}` };
  }

  throw new Error('Formato no soportado (ni .docx ni .pdf)');
}

async function leerTexto(filePath) {
  return leerTextoDeBuffer(fs.readFileSync(filePath));
}

// ─── Parseo del texto → 6 campos ──────────────────────────────────────────────

// Devuelve la primera captura no vacía de la primera regex que matchee.
function primera(texto, regexes) {
  for (const re of regexes) {
    const m = texto.match(re);
    if (m && (m[1] || '').trim()) return norm(m[1]);
  }
  return '';
}

/**
 * parseDeclaracion(texto) → campos crudos del poder.
 * Campos: solicitud, poliza, inmobiliaria, representante, identificacion,
 *         arrendatarios, direccion, ciudad. Además `faltantes` (array).
 */
function parseDeclaracion(texto) {
  const t = norm(texto);

  // póliza - solicitud (primera línea: 4-6 dígitos - 6-8 dígitos)
  let poliza = '', solicitud = '';
  const mSol = t.match(/(\d{4,6})\s*[-–]\s*(\d{6,8})/);
  if (mSol) { poliza = mSol[1]; solicitud = mSol[2]; }

  // Representante: nombre entre "…UNA OBLIGACIÓN" y ", mayor de edad".
  const representante = primera(t, [
    /UNA OBLIGACI[ÓO]N\s*([A-ZÁÉÍÓÚÑ][^,]+?)\s*,?\s*mayor de edad/i,
    /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ.\s]{5,}?)\s*,?\s*mayor de edad/i,
  ]);

  // Inmobiliaria: "representante legal de X" hasta ", hace constar" (tolera "S.A.").
  const inmobiliaria = primera(t, [
    /representante legal de\s+(.+?)\s*,\s*hace constar/i,
    /representante legal de\s+(.+?)\s*,\s*sociedad/i,
    /representante legal de\s+(.+?)\s+hace constar/i,
  ]);

  // Dirección + ciudad: "inmueble: X ciudad Y".
  let direccion = '', ciudad = '';
  const mDir = t.match(/inmueble:?\s*(.+?)\s+ciudad\s+([A-ZÁÉÍÓÚÑ()\s.]+?)(?:\.|,|\bLos\b|\bLas\b|$)/i);
  if (mDir) { direccion = norm(mDir[1]); ciudad = norm(mDir[2]); }

  // Arrendatarios: "siguientes arrendatarios X." (hasta el primer punto).
  const arrendatarios = primera(t, [
    /siguientes arrendatarios\s+(.+?)\.\s/i,
    /arrendatarios?\s+([A-ZÁÉÍÓÚÑ].+?)\.(?:\s|$)/i,
  ]);

  // Identificación del representante: en la firma, tras C.C./C.e./CC No. (antes del NIT).
  // Se busca en la ÚLTIMA parte del texto (bloque de firma) para no tomar otros números.
  const firma = t.slice(Math.max(0, t.indexOf('arrendatarios obligados')));
  const base = firma.length > 20 ? firma : t;
  const mCed = base.match(/C\.?\s*[CcEe]\.?\s*(?:N[Oo]\.?)?\s*([\d][\d.,\s]{5,}\d)/);
  const identificacion = soloDigitos(mCed ? mCed[1] : '');

  const campos = { solicitud, poliza, inmobiliaria, representante, identificacion, arrendatarios, direccion, ciudad };
  const faltantes = ['solicitud', 'inmobiliaria', 'representante', 'identificacion', 'arrendatarios', 'direccion']
    .filter((k) => !campos[k]);
  return { ...campos, faltantes };
}

/**
 * extraerDeArchivo(filePath) → { ...campos, fuente, faltantes }
 * Lee el archivo (docx/pdf/OCR) y parsea los 6 campos.
 */
async function extraerDeArchivo(filePath) {
  const { texto, fuente } = await leerTexto(filePath);
  return { ...parseDeclaracion(texto), fuente };
}

// Igual que extraerDeArchivo pero desde un Buffer (para el endpoint del motor).
async function extraerDeBuffer(buf) {
  const { texto, fuente } = await leerTextoDeBuffer(buf);
  return { ...parseDeclaracion(texto), fuente };
}

/**
 * aFieldMapPoder(campos) → mapa marcador→valor para la plantilla del poder
 * (PLANTILLA PODER DE CONCILIACION.docx, marcadores MERGEFIELD «...»).
 */
function aFieldMapPoder(campos) {
  return {
    SOLICITUD: campos.solicitud || '',
    INMOBILIARIA: campos.inmobiliaria || '',
    REPRESENTANTE_LEGAL_INMOBILIARIA: campos.representante || '',
    IDENTIFICACION_REPRESENTANTE_LEGAL_INMOB: campos.identificacion || '',
    ARRENDATARIOS: campos.arrendatarios || '',
    DIRECCION_INMUEBLE_: campos.direccion || '',
  };
}

module.exports = {
  leerTexto, leerTextoDeBuffer, parseDeclaracion,
  extraerDeArchivo, extraerDeBuffer, aFieldMapPoder,
};
