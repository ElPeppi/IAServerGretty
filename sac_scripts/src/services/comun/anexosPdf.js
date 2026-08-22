/**
 * services/comun/anexosPdf.js — Piezas para armar el PDF de ANEXOS de cualquier
 * proceso.
 *
 * Aquí vive lo que no depende de QUÉ anexos lleva la demanda: las carátulas
 * numeradas, pegar un PDF dentro de otro, el texto justificado, sobreponer el
 * poder en el correo del banco, y localizar los certificados compartidos —CCO
 * J Ramos, SIRNA, Superintendencia Financiera y CCO Finandina— que son los
 * mismos para el ejecutivo singular y para el trámite de pago directo.
 *
 * Lo específico de cada proceso —la LISTA de anexos, su orden y sus textos— vive
 * en finandina/{singular,garantia}/anexos.js.
 *
 * Estaba todo en singular/anexos.js. Se sacó al montar los anexos de garantías,
 * que necesitan exactamente esto mismo.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const AdmZip = require('adm-zip');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const config = require('../../config');

function archivoMasReciente(dir, predicado) {
  let best = null, bestMtime = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.pdf$/i.test(f) || !predicado(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = path.join(dir, f); }
    }
  } catch (e) {
    console.error(`[ANEXOS] No se pudo leer ${dir}: ${e.message}`);
  }
  return best;
}

// Igual que archivoMasReciente pero recorre subcarpetas (el correo del poder
// vive en PODERES/{año}/...).
function archivoMasRecienteRec(dir, predicado) {
  let best = null, bestMtime = -1;
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.pdf$/i.test(e.name) && predicado(e.name)) {
        try { const st = fs.statSync(p); if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; } }
        catch (_) {}
      }
    }
  })(dir);
  return best;
}

// Los certificados compartidos se resuelven una vez y se reusan durante el lote:
// `archivoMasRecienteRec` recorre PODERES entero y se llama UNA VEZ POR CLIENTE.
//
// Pero el caché NO puede ser eterno: el motor corre bajo pm2 sin reiniciarse, y
// antes esto significaba que un certificado nuevo puesto en la carpeta se ignoraba
// hasta el siguiente reinicio — las demandas salían con el del mes pasado, sin
// error ni aviso. Ahora caduca solo, y el sincronizador de insumos lo invalida en
// cuanto escribe un archivo (ver routes/plantillas.routes.js).
const COMPARTIDOS_TTL_MS = 10 * 60 * 1000;

let _compartidos = null;

let _compartidosAt = 0;

/** Fuerza que el próximo lote vuelva a mirar el disco. */
function invalidarCompartidos() {
  _compartidos = null;
}

function resolverCompartidos() {
  if (_compartidos && Date.now() - _compartidosAt < COMPARTIDOS_TTL_MS) return _compartidos;
  _compartidosAt = Date.now();
  const D = config.ANEXOS_DIR_DEMANDAS;
  const F = config.ANEXOS_DIR_FINANDINA;
  _compartidos = {
    ccoJRamos: archivoMasReciente(D, f => /J\s*RAMOS/i.test(f) && !/SIRNA/i.test(f)),
    sirna:     archivoMasReciente(D, f => /SIRNA/i.test(f)),
    superfin:  archivoMasReciente(F, f => /SUPER/i.test(f)),
    // ANEXO 7 — Cámara de Comercio de Banco Finandina. Se prefiere la versión
    // COMPRIMIDA (más liviana al unir) si existe; si no, cualquier "CCO FINANDINA"
    // (p.ej. "CCO FINANDINA JULIO 2026.pdf", que ya no lleva "COMPRIMIDA").
    ccoFin:    archivoMasReciente(F, f => /CCO\s*FINANDINA/i.test(f) && /COMPRIMID/i.test(f))
            || archivoMasReciente(F, f => /CCO\s*FINANDINA/i.test(f)),
    // Correo de otorgamiento del poder (ANEXO 1), respaldo si la web no lo envía.
    // Solo singulares ejecutivos; se excluyen los de pago directo.
    correoPoder: archivoMasRecienteRec(config.ANEXOS_DIR_PODERES,
                   f => /PODERES?\s+EJECUTIVOS?/i.test(f) && !/PAGO\s*DIRECTO/i.test(f)),
  };
  const r = _compartidos;
  console.error(`[ANEXOS] Certificados: JRamos=${r.ccoJRamos ? path.basename(r.ccoJRamos) : 'NO'} | SIRNA=${r.sirna ? path.basename(r.sirna) : 'NO'} | SuperFin=${r.superfin ? path.basename(r.superfin) : 'NO'} | CCOFinandina=${r.ccoFin ? path.basename(r.ccoFin) : 'NO'} | correoPoder=${r.correoPoder ? path.basename(r.correoPoder) : 'NO'}`);
  return _compartidos;
}

function wrap(texto, font, size, maxWidth) {
  const out = [];
  for (const parrafo of texto.split('\n')) {
    const words = parrafo.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
      else { if (cur) out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out;
}

// Igual que wrap(), pero devuelve las PALABRAS de cada línea en vez de la línea
// ya montada. Justificar exige saber dónde caen los huecos.
function partirEnLineas(texto, font, size, maxWidth) {
  const anchoEsp = font.widthOfTextAtSize(' ', size);
  const lineas = [];
  let actual = [];
  let ancho = 0;
  for (const palabra of String(texto).split(/\s+/).filter(Boolean)) {
    const w = font.widthOfTextAtSize(palabra, size);
    const conEsta = actual.length ? ancho + anchoEsp + w : w;
    if (actual.length && conEsta > maxWidth) {
      lineas.push(actual);
      actual = [palabra];
      ancho = w;
    } else {
      actual.push(palabra);
      ancho = conEsta;
    }
  }
  if (actual.length) lineas.push(actual);
  return lineas;
}

// Cuánto se deja estirar un espacio antes de renunciar a justificar la línea,
// en múltiplos del espacio normal. Sin este tope, una línea de dos palabras
// repartida a lo ancho de la página queda ilegible.
const ESTIRON_MAX = 3.5;

/**
 * Dibuja una línea JUSTIFICADA: reparte el sobrante entre los huecos para que
 * empiece y acabe en el margen, como el poder en Word.
 *
 * pdf-lib no sabe justificar —drawText solo coloca un bloque de texto en una x—,
 * así que se dibuja palabra por palabra calculando su posición.
 *
 * No se justifica la ÚLTIMA línea de cada párrafo (quedaría estirada sin motivo),
 * ni las de una sola palabra, ni aquellas cuyo hueco resultante sería absurdo.
 */
function dibujarLinea(page, palabras, { x, y, size, font, maxWidth, justificar }) {
  const plano = () => page.drawText(palabras.join(' '), { x, y, size, font });
  if (!justificar || palabras.length < 2) return plano();

  const anchoPalabras = palabras.reduce((s, w) => s + font.widthOfTextAtSize(w, size), 0);
  const hueco = (maxWidth - anchoPalabras) / (palabras.length - 1);
  const normal = font.widthOfTextAtSize(' ', size);
  if (!(hueco > 0) || hueco > normal * ESTIRON_MAX) return plano();

  let cx = x;
  for (const palabra of palabras) {
    page.drawText(palabra, { x: cx, y, size, font });
    cx += font.widthOfTextAtSize(palabra, size) + hueco;
  }
  return undefined;
}

// Carátula "ANEXO N" + descripción centrada
function caratula(out, fontB, font, n, descripcion) {
  const W = 612, H = 792;
  const page = out.addPage([W, H]);
  const titulo = `ANEXO ${n}`;
  const tS = 18;
  const tw = fontB.widthOfTextAtSize(titulo, tS);
  page.drawText(titulo, { x: (W - tw) / 2, y: H - 170, size: tS, font: fontB });

  const dS = 13, maxW = 450;
  const lines = wrap(descripcion, font, dS, maxW);
  let y = H - 215;
  for (const ln of lines) {
    const lw = font.widthOfTextAtSize(ln, dS);
    page.drawText(ln, { x: (W - lw) / 2, y, size: dS, font });
    y -= dS * 1.6;
  }
}

async function anexarPdf(out, srcBytes, soloPaginas) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  let idx = soloPaginas || src.getPageIndices();
  idx = idx.filter(i => i >= 0 && i < src.getPageCount());
  const pgs = await out.copyPages(src, idx);
  pgs.forEach(p => out.addPage(p));
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Extrae el texto del poder .docx como una lista de párrafos (una entrada por
// <w:p>; las vacías marcan saltos de línea entre bloques).
function extraerParrafosDocx(docxBuffer) {
  const zip = new AdmZip(docxBuffer);
  const xml = zip.readAsText('word/document.xml');
  const parrafos = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    let inner = m[1].replace(/<w:tab\b[^>]*\/>/g, ' ').replace(/<w:br\b[^>]*\/>/g, ' ');
    let txt = '';
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) txt += t[1];
    parrafos.push(decodeXml(txt).replace(/\s+/g, ' ').trim());
  }
  // recortar párrafos vacíos al inicio/fin
  while (parrafos.length && !parrafos[0]) parrafos.shift();
  while (parrafos.length && !parrafos[parrafos.length - 1]) parrafos.pop();
  return parrafos;
}

// Sobrepone el texto del poder en el cuerpo en blanco del correo (página 1).
// El tamaño de fuente se reduce hasta que todo el poder quepa entre el
// encabezado del correo y el pie de página.
async function paginaPoderOverlay(out, correoBuffer, parrafos) {
  const correo = await PDFDocument.load(correoBuffer, { ignoreEncryption: true });
  const page   = correo.getPage(0);
  const { width, height } = page.getSize();
  const cFont  = await correo.embedFont(StandardFonts.Helvetica);

  const left = 75, maxW = width - 150;
  const startY = height - 180;   // debajo del encabezado del correo
  const bottom = 35;             // encima del pie (URL de Gmail)
  const available = startY - bottom;

  // Elegir el tamaño de fuente más grande (10..7) con el que todo quepa.
  // `null` en la lista = separación entre bloques (el párrafo vacío del .docx).
  let size = 10, leading = 12.5, renglones = [];
  for (; size >= 7; size -= 0.5) {
    leading = size * 1.25;
    renglones = [];
    for (const p of parrafos) {
      if (!p) { renglones.push(null); continue; }
      const lineas = partirEnLineas(p, cFont, size, maxW);
      lineas.forEach((palabras, i) => renglones.push({ palabras, ultima: i === lineas.length - 1 }));
      renglones.push(null);
    }
    let h = 0;
    for (const r of renglones) h += r ? leading : leading * 0.55;
    if (h <= available) break;
  }

  let y = startY;
  for (const r of renglones) {
    if (!r) { y -= leading * 0.55; continue; }
    if (y < bottom) break;
    dibujarLinea(page, r.palabras, {
      x: left, y, size, font: cFont, maxWidth: maxW,
      // La última línea de un párrafo se deja como caiga: estirarla es justo lo
      // que delata un texto justificado a la fuerza.
      justificar: !r.ultima,
    });
    y -= leading;
  }

  const [copied] = await out.copyPages(correo, [0]);
  out.addPage(copied);
}

module.exports = {
  archivoMasReciente,
  archivoMasRecienteRec,
  invalidarCompartidos,
  resolverCompartidos,
  wrap,
  partirEnLineas,
  dibujarLinea,
  caratula,
  anexarPdf,
  extraerParrafosDocx,
  paginaPoderOverlay,
};
