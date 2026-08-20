/**
 * services/ocr.js — OCR de PDFs escaneados (sin texto).
 *
 * Rasteriza cada página con pdf-to-img (pdfjs + canvas, puro Node) y la pasa por
 * el motor de OCR configurado. Devuelve el texto por página + un extractor de
 * campos típicos de pagaré / carta de instrucciones.
 *
 * DOS MOTORES, misma salida (ver OCR_MOTOR en src/config.js):
 *   tesseract → local y gratis, pero SOLO lee tipografía, no caligrafía.
 *   vision    → Google Cloud Vision; sí lee manuscrito, se paga por página.
 * Vision cae a Tesseract si falla, para no tumbar la generación por un
 * problema de red o de facturación. El rasterizado es común a los dos.
 *
 * Nota: tesseract.js descarga el idioma 'spa' la primera vez (cachea). Para
 * producción offline se puede fijar langPath a una copia local de spa.traineddata.
 */
'use strict';

const config = require('../config');

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
  const aLeer = imgs.slice(0, maxPages);

  if (config.OCR_MOTOR === 'vision') {
    try {
      // require aquí dentro: con OCR_MOTOR=tesseract el motor arranca aunque
      // no esté instalada google-auth-library.
      const pages = await require('./visionOcr').ocrImagenes(aLeer);
      return armar(imgs.length, pages, 'vision');
    } catch (e) {
      // Se sigue con Tesseract A PROPÓSITO: una demanda con el número leído
      // regular es recuperable; una generación caída a mitad, no. El aviso
      // queda en el log del motor para que no pase inadvertido.
      console.warn(`[OCR] Vision falló, se usa Tesseract: ${e.message}`);
    }
  }

  const worker = await getWorker(lang);
  const pages = [];
  for (let i = 0; i < aLeer.length; i++) {
    const { data } = await worker.recognize(aLeer[i]);
    pages.push({ page: i + 1, confidence: Math.round(data.confidence || 0), text: (data.text || '').trim() });
  }
  return armar(imgs.length, pages, 'tesseract');
}

function armar(numPages, pages, motor) {
  return { numPages, pages, motor, text: pages.map((p) => p.text).join('\n\n') };
}

// ─── Fechas ─────────────────────────────────────────────────────────────────
const MESES = { enero:1, febrero:2, marzo:3, abril:4, mayo:5, junio:6, julio:7,
                agosto:8, septiembre:9, setiembre:9, octubre:10, noviembre:11, diciembre:12 };
// Día en letras → número (el pagaré suele traer "uno (1)", "DOCE (12)", etc.; el
// dígito entre paréntesis a veces lo lee mal el OCR, así que la PALABRA manda).
const DIA_PALABRA = {
  uno:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7, ocho:8, nueve:9, diez:10,
  once:11, doce:12, trece:13, catorce:14, quince:15, dieciseis:16, diecisiete:17,
  dieciocho:18, diecinueve:19, veinte:20, veintiuno:21, veintidos:22, veintitres:23,
  veinticuatro:24, veinticinco:25, veintiseis:26, veintisiete:27, veintiocho:28,
  veintinueve:29, treinta:30, treintayuno:31,
};
const sinTilde = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Fecha de SUSCRIPCIÓN = la constancia de firma del pagaré:
//   "Para constancia se firma en la ciudad de X ... el día <uno|03|(12)> del mes
//    de <Mes> del año <YYYY>"  (también la variante "a los (N) días del mes de…").
// OJO: NO es la fecha de la cláusula PRIMERO ("...el día N del mes de M del año Y,
// en sus oficinas del país…"), que es el vencimiento. Por eso anclamos en "se firma".
// El OCR inserta "_" en las líneas de relleno → toleramos [_\s] entre tokens.
function parseFechaFirma(t) {
  const re = /se firma[\s\S]{0,200}?(?:el d[ií]a|a los)[_\s]*([A-Za-zÁÉÍÓÚÑáéíóúñ]+)?[_\s]*\(?\s*(\d{1,2})?\s*\)?[_\s]*(?:d[ií]as?\s+)?del mes de[_\s]*([A-Za-zÁÉÍÓÚÑáéíóúñ]+)[\s\S]{0,15}?del a[ñn]o[_\s]*(\d{4})/ig;
  let m;
  while ((m = re.exec(t)) !== null) {
    const [, palabra, digito, mesTxt, anio] = m;
    let dia = null;
    if (palabra) {
      const k = sinTilde(palabra);
      if (DIA_PALABRA[k] !== undefined) dia = DIA_PALABRA[k];
      else if (/^\d+$/.test(palabra)) dia = parseInt(palabra, 10);
    }
    if (dia == null && digito) dia = parseInt(digito, 10);
    const mm = MESES[sinTilde(mesTxt)];
    if (dia && mm && anio) {
      return `${String(dia).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${anio}`;
    }
  }
  return '';
}

// ─── Extracción de campos (mejor esfuerzo) ──────────────────────────────────
function extraerCamposPagare(text) {
  const t = (text || '').replace(/\r/g, '');
  const cap = (re) => { const m = t.match(re); return m ? (m[1] || m[2] || '').trim() : ''; };

  // Las palabras del nombre NO deben cruzar renglón (si no, se come "IDENTIFICACIÓN"
  // de la línea siguiente): separador entre palabras = espacios/tabs, no \n.
  const nombre = cap(/Nombre o Raz[oó]n Social:\s*([A-ZÁÉÍÓÚÑ]+(?:[ \t]+[A-ZÁÉÍÓÚÑ]+){1,5})/i);
  const cedula = cap(/Identificaci[oó]n\s*\([^)]*\)\s*:?\s*(\d{6,})/i);
  // Dirección: tomar la línea y aislar el patrón de vía colombiana (CR/CL/KR…).
  const dirLinea = cap(/Direcci[oó]n:\s*([^\n]+)/i);
  const dirM = dirLinea.match(/\b((?:CR|CRA|CL|CLL|KR|KRA|AV|AC|AK|TV|DG|CQ|MZ)[A-Z]?\.?\s*\d[A-Z0-9#\-\s]{1,20})/i);
  const direccion = dirM
    ? dirM[1].replace(/\s+/g, ' ').replace(/\s+[A-Za-z]{1,2}$/, '').trim() // quita cola de ruido OCR
    : '';
  const telefono = cap(/Tel[eé]fono:\s*(\d{7,})/i);
  const ciudad = cap(/(?:firma|firmar?se)?\s*en la ciudad de\s+([A-ZÁÉÍÓÚÑ]{4,})/i);

  // Fecha de suscripción (constancia de firma) normalizada DD/MM/YYYY.
  const fechaCorta = parseFechaFirma(t);
  const fecha = fechaCorta ? fechaCorta.split('/').reverse().join('-') : '';

  // ── ¿El CUERPO del pagaré está DILIGENCIADO? ────────────────────────────────
  // Para prestar mérito ejecutivo el pagaré escaneado debe tener LLENO su cuerpo
  // (como el de WILHEN), no solo la firma/datos del deudor (como el de MARYLUZ,
  // que tiene nombre+cédula+firma pero el cuerpo en blanco → NO se puede demandar).
  // Señales de cuerpo lleno (cualquiera basta):
  //   • Número de pagaré escrito (top "PAGARÉ No. <dígitos>" o en la carta de instr.)
  //   • Fecha de vencimiento de la cláusula PRIMERO ("…del año YYYY, en sus oficinas")
  //   • Monto de capital ("POR CAPITAL ($ <dígitos>")
  // El OCR suele meter un guión (— – -) entre "No." y el número → se tolera además de _ : espacios.
  const numM = t.match(/PAGAR[EÉ]\s*N[o0]\.?\s*[-–—_:\s]*([0-9][0-9.\s]{4,}[0-9])/i);
  const numeroPagare = numM ? numM[1].replace(/[^\d]/g, '') : '';
  const tieneVencimiento = /el d[ií]a[_\s]*\(?\s*\d{1,2}\s*\)?[_\s]*del mes de[_\s]*[A-Za-zÁÉÍÓÚÑáéíóúñ]+[\s\S]{0,20}?del a[ñn]o[_\s]*\d{4}[\s\S]{0,25}?oficinas/i.test(t);
  const tieneCapital = /POR\s+CAPITAL[\s\S]{0,40}?\$\s*([0-9][0-9.\s]{2,})/i.test(t);

  const diligenciado = !!(numeroPagare || tieneVencimiento || tieneCapital);

  return { nombre, cedula, direccion, telefono, ciudad, fecha, fechaCorta, numeroPagare, diligenciado };
}

module.exports = { ocrPdf, extraerCamposPagare, cerrarOcr };
