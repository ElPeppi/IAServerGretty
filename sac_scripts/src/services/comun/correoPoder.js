/**
 * services/comun/correoPoder.js — Revisa y limpia el correo del banco que otorga
 * el poder (ANEXO 1), antes de sobreponerle el poder del cliente.
 *
 * El correo es la impresión de Gmail del mensaje de notificacionesjudiciales@
 * bancofinandina.com. Llega con cuerpo: "Cordial saludo…", la firma del banco con
 * su logo y sellos, dos AVISO LEGAL y el adjunto. La oficina tiene que borrar ese
 * cuerpo a mano —dejando solo el encabezado— porque el poder se escribe ENCIMA
 * (anexosPdf.paginaPoderOverlay); si se le olvida, salen los dos textos montados.
 * De los 46 PDF de PODERES en Drive (nov-2026), 17 estaban sin limpiar.
 *
 * Qué se ve en la primera página:
 *   limpio       encabezado de Gmail ("1 mensaje", "Para:") y nada debajo
 *   con_texto    encabezado + cuerpo del mensaje → se tapa todo lo de debajo de "Para:"
 *   no_es_correo no es el correo del banco: no trae el encabezado de Gmail (p. ej.
 *                el Word de los poderes que se manda al banco) o el remitente no es
 *                el banco (un "Fwd:" reenviado desde la oficina). No sirve.
 *   ilegible     no se pudo leer ni con OCR → se usa tal cual
 *
 * La posición del encabezado se lee del texto del PDF. Los escaneados, y las
 * impresiones con fuentes sin tabla de caracteres (salen códigos basura), se leen
 * con OCR: tarda 1–3 s, así que el resultado se guarda por contenido del PDF —en
 * un lote, el mismo correo se revisa una vez y no una por cliente.
 */

'use strict';

const crypto = require('crypto');
const pdfParse = require('pdf-parse');

// Línea más baja del encabezado del mensaje. Debajo empieza el cuerpo.
const LINEA_ENCABEZADO_RE = /^(Para|Cc|Cco|CC|CCO)\s*:/;
// Pie que Chrome pone al imprimir (URL del mensaje y "1/2"): no es cuerpo.
const PIE_RE = /mail\.google\.com|^\d+\s*\/\s*\d+$/;
// Remitente que tiene que salir en el encabezado (el OCR lee la @ como Q u O).
const REMITENTE_BANCO_RE = /bancofinandina/i;
// Por debajo de la línea "Para:" se deja esto de margen antes de tapar (puntos).
const HOLGURA = 3;
// Con menos caracteres legibles que esto, el texto del PDF no sirve → OCR.
const MIN_LEGIBLES = 40;

/**
 * Líneas de la primera página con su caja vertical, en puntos desde ARRIBA.
 * Del texto del PDF si es legible (o `forzarOcr`); si no, por OCR.
 */
async function lineasDelCorreo(buffer, forzarOcr = false) {
  let items = [];
  let alto = 792;
  const parsed = await pdfParse(buffer, {
    max: 1,
    pagerender: async (pd) => {
      const [, y0, , y1] = pd.view;
      alto = y1 - y0;
      const tc = await pd.getTextContent();
      items = tc.items.map((i) => {
        const base = i.transform[5] - y0;                 // línea base, desde abajo
        const t = Math.abs(i.transform[3]) || i.height || 10; // tamaño de letra
        return { texto: String(i.str).trim(), arriba: alto - base - t * 0.8, abajo: alto - base + t * 0.25 };
      }).filter((i) => i.texto);
      return '';
    },
  });
  const paginas = parsed.numpages || 1;
  const legibles = (items.map((i) => i.texto).join('').match(/[A-Za-zÁÉÍÓÚáéíóúÑñ0-9]/g) || []).length;
  if (!forzarOcr && legibles >= MIN_LEGIBLES) return { alto, paginas, lineas: items, fuente: 'texto' };

  const { lineasPrimeraPagina } = require('../ocr');
  const ocr = await lineasPrimeraPagina(buffer);
  return { alto: ocr.alto || alto, paginas, lineas: ocr.lineas, fuente: 'ocr' };
}

const tieneEncabezadoGmail = (lineas) =>
  /\b\d+\s+mensajes?\b/i.test(lineas.map((l) => l.texto).join(' '))
  && lineas.some((l) => LINEA_ENCABEZADO_RE.test(l.texto));

async function analizar(buffer) {
  let datos;
  try {
    datos = await lineasDelCorreo(buffer);
    // Texto "legible" que no trae el encabezado: o no es un correo, o es una
    // impresión con fuentes sin tabla de caracteres (letras sueltas + basura).
    // Antes de descartarlo se mira con OCR.
    if (datos.fuente === 'texto' && !tieneEncabezadoGmail(datos.lineas)) {
      datos = await lineasDelCorreo(buffer, true);
    }
  } catch (e) {
    return { estado: 'ilegible', paginas: 0, corte: null, caracteresCuerpo: 0, muestra: '', motivo: e.message };
  }
  const { alto, paginas, lineas, fuente } = datos;
  const texto = lineas.map((l) => l.texto).join(' ');
  const encabezado = lineas.filter((l) => LINEA_ENCABEZADO_RE.test(l.texto));
  const base = { paginas, fuente, caracteresCuerpo: 0, muestra: '' };

  if (!lineas.length) return { ...base, estado: 'ilegible', corte: null };
  if (!tieneEncabezadoGmail(lineas)) {
    return { ...base, estado: 'no_es_correo', corte: null, motivo: 'sin_encabezado', muestra: texto.slice(0, 120) };
  }

  // Todo lo que queda por debajo de la línea "Para:" (o "Cc:") es cuerpo.
  const finEncabezado = Math.max(...encabezado.map((l) => l.abajo)) + HOLGURA;
  const arribaDelCorte = lineas.filter((l) => l.abajo <= finEncabezado).map((l) => l.texto).join(' ');
  if (!REMITENTE_BANCO_RE.test(arribaDelCorte)) {
    return { ...base, estado: 'no_es_correo', corte: null, motivo: 'remitente', muestra: arribaDelCorte.slice(0, 160) };
  }
  const cuerpo = lineas.filter((l) => l.arriba > finEncabezado - HOLGURA && !encabezado.includes(l) && !PIE_RE.test(l.texto));
  const caracteresCuerpo = cuerpo.reduce((n, l) => n + l.texto.length, 0);
  return {
    ...base,
    estado: caracteresCuerpo ? 'con_texto' : 'limpio',
    // pdf-lib mide desde ABAJO: por debajo de esta altura se tapa.
    corte: alto - finEncabezado,
    caracteresCuerpo,
    muestra: cuerpo.map((l) => l.texto).join(' ').replace(/\s+/g, ' ').slice(0, 120),
  };
}

// Revisión por contenido del PDF: en un lote el MISMO correo pasa una vez por
// cliente, y con OCR cada pasada cuesta segundos.
const cache = new Map();
const CACHE_MAX = 16;

/**
 * Analiza la PRIMERA página del correo (la única que se usa).
 * @returns {Promise<{estado:'limpio'|'con_texto'|'no_es_correo'|'ilegible', paginas:number,
 *   corte:number|null, caracteresCuerpo:number, muestra:string, fuente?:'texto'|'ocr',
 *   motivo?:string}>}  `corte`: altura en puntos, desde abajo, bajo la cual todo es cuerpo.
 */
function analizarCorreoPoder(buffer) {
  const clave = crypto.createHash('sha1').update(buffer).digest('hex');
  if (!cache.has(clave)) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(clave, analizar(buffer));
  }
  return cache.get(clave);
}

/** Explicación para la oficina de por qué un PDF no sirve como correo del poder. */
function motivoNoEsCorreo(revision) {
  if (revision && revision.motivo === 'remitente') {
    return 'el correo elegido no es el del banco: el remitente del encabezado no es '
      + 'notificacionesjudiciales@bancofinandina.com (¿es un reenvío?). Elige el correo '
      + 'que mandó el banco';
  }
  return 'el PDF elegido no es el correo del banco: no trae el encabezado de Gmail '
    + '("1 mensaje", "Para:"). Elige el correo de OTORGAMIENTO, no el documento de los poderes'
    + (revision && revision.paginas > 1 ? ` (este tiene ${revision.paginas} páginas)` : '');
}

module.exports = { analizarCorreoPoder, motivoNoEsCorreo };
