/**
 * services/comun/pdfTexto.js — Texto de un PDF, respetando los espacios.
 *
 * POR QUÉ NO BASTA pdf-parse: pega los fragmentos de una línea sin mirar dónde
 * están. En los formularios de Confecámaras eso devuelve
 * "REGISTRODEGARANTÍASMOBILIARIAS" y direcciones como "[CL11A 11A 68ESTE]"
 * cuando el original dice "CL 7   13 A 83". Con esos textos no se puede sacar la
 * dirección del garante, que va tal cual a la demanda.
 *
 * Curiosamente el mismo formulario generado en otra fecha SÍ trae los espacios,
 * así que no vale con arreglar un caso: hay que reconstruirlos siempre.
 *
 * CÓMO: pdfjs da cada fragmento con su posición y su ancho. Si entre el final de
 * uno y el principio del siguiente hay un hueco apreciable, ahí iba un espacio.
 * El umbral es relativo al tamaño de letra, no absoluto, para que funcione igual
 * en un formulario a 7pt que en un contrato a 12pt.
 *
 * Solo sirve para PDFs con capa de texto. Para los escaneados (el contrato de
 * prenda) está services/ocr.js.
 */
'use strict';

// Hueco a partir del cual se considera que hay un espacio, como fracción del
// alto de la letra. 0.20 separa palabras sin partir las que van justas; subirlo
// pega palabras, bajarlo mete espacios dentro de una misma palabra.
const HUECO_ESPACIO = 0.20;
// Diferencia vertical a partir de la cual dos fragmentos son líneas distintas.
const SALTO_LINEA = 0.50;

let _pdfjs = null;
async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  // ESM → import dinámico, igual que pdf-to-img en services/ocr.js.
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

/** Un item de pdfjs → fragmento con posición. transform = [a,b,c,d,e,f]:
 *  e/f son la x/y y d el alto efectivo de la letra. */
function aFragmento(it) {
  if (!it || !it.str) return null;
  const [, , , alto, x, y] = it.transform;
  return { str: it.str, x, y, ancho: it.width || 0, alto: Math.abs(alto) || 10 };
}

/** Abre el PDF, aplica `fn` al textContent de cada página y devuelve
 *  { total, paginas: [resultado de fn por página] }. */
async function recorrer(buffer, opts, fn) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // Sin worker: esto corre en Node, dentro del proceso del motor.
    useWorkerFetch: false,
    isEvalSupported: false,
    // Los formularios de Confecámaras traen fuentes incrustadas parciales; sin
    // esto pdfjs se queja por consola en cada página y no aporta nada.
    verbosity: 0,
  }).promise;

  const total = doc.numPages;
  const hasta = Math.min(total, opts.maxPages || total);
  const paginas = [];
  for (let p = 1; p <= hasta; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    paginas.push(fn(items));
    page.cleanup();
  }
  await doc.destroy();
  return { total, paginas };
}

/**
 * Fragmentos de texto con su posición, página a página.
 *
 * Los formularios de Confecámaras son tablas: la etiqueta y su valor comparten
 * la MISMA x y están en filas contiguas. Con eso se leen campo por campo sin
 * depender de cómo quede el texto plano (ver comun/pdfFormulario.js).
 *
 * @returns {Promise<{numPages:number, paginas:Array<Array<Fragmento>>}>}
 */
async function fragmentosDePdf(buffer, opts = {}) {
  const r = await recorrer(buffer, opts, (items) =>
    items.map(aFragmento).filter((f) => f && f.str.trim()));
  return { numPages: r.total, paginas: r.paginas };
}

/**
 * Texto plano con los espacios reconstruidos.
 *
 * @returns {Promise<{numPages:number, paginas:string[], texto:string}>}
 */
async function textoDePdf(buffer, opts = {}) {
  const r = await recorrer(buffer, opts, componer);
  return { numPages: r.total, paginas: r.paginas, texto: r.paginas.join('\n\n') };
}

/** Reconstruye el texto de una página a partir de los fragmentos posicionados. */
function componer(items) {
  const frags = items.map(aFragmento).filter((f) => f && f.str);
  if (!frags.length) return '';

  // De arriba abajo y de izquierda a derecha. El orden en que vienen los
  // fragmentos NO es el de lectura: depende de cómo se generó el PDF.
  frags.sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x));

  const lineas = [];
  let actual = [frags[0]];
  for (let i = 1; i < frags.length; i++) {
    const prev = actual[actual.length - 1];
    const f = frags[i];
    if (Math.abs(f.y - prev.y) > prev.alto * SALTO_LINEA) {
      lineas.push(actual);
      actual = [f];
    } else {
      actual.push(f);
    }
  }
  lineas.push(actual);

  return lineas.map(unirLinea).join('\n');
}

function unirLinea(frags) {
  frags.sort((a, b) => a.x - b.x);
  let out = frags[0].str;
  for (let i = 1; i < frags.length; i++) {
    const prev = frags[i - 1];
    const f = frags[i];
    const hueco = f.x - (prev.x + prev.ancho);
    const yaSeparado = /\s$/.test(out) || /^\s/.test(f.str);
    if (!yaSeparado && hueco > prev.alto * HUECO_ESPACIO) out += ' ';
    out += f.str;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

module.exports = { textoDePdf, fragmentosDePdf };
