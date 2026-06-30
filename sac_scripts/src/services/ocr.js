/**
 * services/ocr.js — OCR de PDFs escaneados (sin texto) con tesseract.js.
 *
 * Rasteriza cada página con pdf-to-img (pdfjs + canvas, puro Node) y la pasa por
 * tesseract.js en español. Devuelve el texto por página + un extractor de campos
 * típicos de pagaré / carta de instrucciones.
 *
 * Nota: tesseract.js descarga el idioma 'spa' la primera vez (cachea). Para
 * producción offline se puede fijar langPath a una copia local de spa.traineddata.
 */
'use strict';

let Tesseract = null;
let _worker = null;

async function getWorker(lang) {
  if (_worker) return _worker;
  Tesseract = Tesseract || require('tesseract.js');
  _worker = await Tesseract.createWorker(lang || 'spa');
  return _worker;
}

async function cerrarOcr() {
  if (_worker) { try { await _worker.terminate(); } catch (_) {} _worker = null; }
}

// Rasteriza un PDF (Buffer) a PNG por página. pdf-to-img es ESM → import dinámico.
async function rasterizar(buffer, scale) {
  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(buffer, { scale: scale || 3 });
  const imgs = [];
  for await (const page of doc) imgs.push(page); // page = Buffer PNG
  return imgs;
}

/**
 * OCR de un PDF escaneado. Devuelve { numPages, pages:[{page,confidence,text}], text }.
 */
async function ocrPdf(buffer, opts = {}) {
  const { lang = 'spa', scale = 3, maxPages = 12 } = opts;
  const imgs = await rasterizar(buffer, scale);
  const worker = await getWorker(lang);
  const pages = [];
  for (let i = 0; i < imgs.length && i < maxPages; i++) {
    const { data } = await worker.recognize(imgs[i]);
    pages.push({ page: i + 1, confidence: Math.round(data.confidence || 0), text: (data.text || '').trim() });
  }
  return { numPages: imgs.length, pages, text: pages.map((p) => p.text).join('\n\n') };
}

// ─── Extracción de campos (mejor esfuerzo) ──────────────────────────────────
function extraerCamposPagare(text) {
  const t = (text || '').replace(/\r/g, '');
  const cap = (re) => { const m = t.match(re); return m ? (m[1] || m[2] || '').trim() : ''; };

  const nombre = cap(/Nombre o Raz[oó]n Social:\s*([A-ZÁÉÍÓÚÑ]+(?:\s+[A-ZÁÉÍÓÚÑ]+){1,5})/i);
  const cedula = cap(/Identificaci[oó]n\s*\([^)]*\)\s*:?\s*(\d{6,})/i);
  // Dirección: tomar la línea y aislar el patrón de vía colombiana (CR/CL/KR…).
  const dirLinea = cap(/Direcci[oó]n:\s*([^\n]+)/i);
  const dirM = dirLinea.match(/\b((?:CR|CRA|CL|CLL|KR|KRA|AV|AC|AK|TV|DG|CQ|MZ)[A-Z]?\.?\s*\d[A-Z0-9#\-\s]{1,20})/i);
  const direccion = dirM
    ? dirM[1].replace(/\s+/g, ' ').replace(/\s+[A-Za-z]{1,2}$/, '').trim() // quita cola de ruido OCR
    : '';
  const telefono = cap(/Tel[eé]fono:\s*(\d{7,})/i);
  const ciudad = cap(/(?:firma|firmar?se)?\s*en la ciudad de\s+([A-ZÁÉÍÓÚÑ]{4,})/i);
  // Fecha de suscripción (constancia de firma). Dos formatos en uso:
  //   • "...el día 03 del mes de mayo del año 2023"          (pagaré impreso)
  //   • "...a los DOCE (12) días del mes de MARZO del año 2024" (diligenciado a mano)
  // En el 2º, el número en letras precede al dígito entre paréntesis → se toma el dígito.
  const fechaM = t.match(/(?:el d[ií]a|a los)\s+(?:[A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+)?\(?(\d{1,2})\)?\s*(?:d[ií]as?\s+)?del mes de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+)\s+del a[ñn]o\s+(\d{4})/i);
  const fecha = fechaM ? `${fechaM[1]} de ${fechaM[2]} de ${fechaM[3]}` : '';

  // Fecha normalizada DD/MM/YYYY (para usarla igual que la del certificado DECEVAL)
  const MESES = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7,
                  agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
  let fechaCorta = '';
  if (fechaM) {
    const mm = MESES[fechaM[2].toLowerCase()];
    if (mm) fechaCorta = `${String(fechaM[1]).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${fechaM[3]}`;
  }

  // ¿El pagaré está DILIGENCIADO? Un pagaré escaneado en blanco (sin firmar/llenar)
  // no produce ninguno de estos datos; uno diligenciado trae al menos la fecha de
  // suscripción, la identificación o el nombre del deudor.
  const diligenciado = !!(
    cedula ||
    fechaCorta ||
    ciudad ||
    (nombre && nombre.trim().split(/\s+/).length >= 2)
  );

  return { nombre, cedula, direccion, telefono, ciudad, fecha, fechaCorta, diligenciado };
}

module.exports = { ocrPdf, extraerCamposPagare, cerrarOcr };
