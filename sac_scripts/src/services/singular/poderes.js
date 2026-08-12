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

/**
 * Convierte los CAMPOS de Word (MERGEFIELD de combinación de correspondencia) en
 * texto plano: borra los runs con el código del campo (`fldChar`/`instrText`) y
 * deja el RESULTADO, que es donde va nuestro valor.
 *
 * Hace falta porque la plantilla del PAGO DIRECTO viene de un mail-merge: si se
 * dejan los códigos, al abrir el .docx Word intenta reconectarse al origen de
 * datos original y, si actualiza los campos, borra los valores que pusimos.
 * En plantillas sin campos (la del ejecutivo singular) no toca nada.
 */
function aplanarCamposWord(xml) {
  // Un <w:r> no anida otros <w:r>, así que el match no-codicioso es seguro.
  return xml.replace(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g,
    (run) => (/<w:(?:fldChar|instrText)\b/.test(run) ? '' : run));
}

/** Quita la configuración de combinación de correspondencia del .docx. */
function desactivarMailMerge(zip) {
  try {
    const s = zip.readAsText('word/settings.xml');
    if (!s || !/<w:mailMerge[\s>]/.test(s)) return;
    const limpio = s.replace(/<w:mailMerge[\s\S]*?<\/w:mailMerge>/g, '')
                    .replace(/<w:mailMerge[^>]*\/>/g, '');
    zip.updateFile('word/settings.xml', Buffer.from(limpio, 'utf8'));
  } catch (_) { /* sin settings.xml: nada que desactivar */ }
}

function fillPoder(templateBuffer, fieldMap) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');
  xml = reemplazarCampos(xml, fieldMap);
  xml = aplanarCamposWord(xml);
  desactivarMailMerge(zip);

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

// ─── Constructores de campos por tipo de poder ───────────────────────────────
// Cada uno recibe un item y devuelve { fieldMap, cliente } — o null si le faltan
// los datos mínimos. `cliente` es lo que se le reporta a la web.

// Hueco visible para quien revise el documento (misma convención que la demanda).
const FALTA = '#####';

/** PODER EJECUTIVO SINGULAR: los 6 marcadores de la plantilla de siempre. */
function camposSingular(item) {
  const fila   = item.fila || item;
  const cedula = String(fila['IDENTIFICACION'] || '').trim();
  if (!cedula) return null;

  const fieldMap = buildFieldMap(fila);
  // Nº de pagaré del poder: override si el llamador lo resolvió (docs en servidor).
  if (item.pagare != null && String(item.pagare).trim()) {
    fieldMap.OBLIGACION = String(item.pagare).trim();
  }
  return {
    fieldMap,
    cliente: {
      cedula,
      nombre: String(fila['NOMBRE'] || '').trim(),
      pagare: String(fieldMap.OBLIGACION || '').trim(),
    },
  };
}

/**
 * PODER DE TRÁMITE DE PAGO DIRECTO (garantía mobiliaria): aprehensión y entrega
 * del vehículo. Sin cuantía ni obligaciones; el bien se identifica con
 * marca/modelo/placa. Ojo con los nombres: esta plantilla dice «CIUDAD_JUZGADO»
 * (sin "DE"), a diferencia de la del ejecutivo singular.
 *
 * item: { cedula, nombre, tipoJuzgado, ciudadJuzgado, placa, marca, modelo }
 */
function camposPagoDirecto(item) {
  const cedula = String(item.cedula || '').trim();
  if (!cedula) return null;
  const nombre = String(item.nombre || '').trim();
  const placa  = String(item.placa  || '').trim().toUpperCase();
  const marca  = String(item.marca  || '').trim();
  const modelo = String(item.modelo || '').trim();

  return {
    fieldMap: {
      TIPO_DE_JUZGADO: String(item.tipoJuzgado   || '').trim(),
      CIUDAD_JUZGADO:  String(item.ciudadJuzgado || '').trim(),
      // Decisión del despacho: en "CONTRA:" va SOLO el nombre del garante.
      DEMANDADO_1:     nombre,
      // El dato del banco viene como "CHEVROLET ONIX" (marca + línea) y se usa
      // completo: identifica mejor el bien a aprehender.
      MARCA:           marca  || FALTA,
      MODELO:          modelo || FALTA,
      PLACA:           placa  || FALTA,
    },
    cliente: { cedula, nombre, placa, marca, modelo },
  };
}

// Los poderes de pago directo no hablan de obligaciones → no hay plural que ajustar.
const sinPostProceso = (xml) => xml;

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
function generarPoderesCombinado(items, templateDocxPath, opts = {}) {
  // Cómo se arma el mapa «CAMPO»→valor de cada cliente. Por defecto, el poder
  // EJECUTIVO SINGULAR (buildFieldMap sobre la fila canónica). El trámite de PAGO
  // DIRECTO usa otra plantilla y otros marcadores → pasa su propio constructor.
  const construirCampos = opts.construirCampos || camposSingular;
  const postProcesar    = opts.postProcesar    || fixObligacionPlural;

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
    const armado = construirCampos(item);
    if (!armado) continue;                       // sin cédula / datos mínimos
    const { fieldMap, cliente } = armado;

    let bloque = reemplazarCampos(cuerpo, fieldMap);
    bloque = postProcesar(bloque, fieldMap);
    bloques.push(bloque);
    clientes.push(cliente);
  }

  if (!bloques.length) throw new Error('No hay clientes válidos (columna IDENTIFICACION) para generar poderes');

  // Aplanar los MERGEFIELD al final (una sola pasada sobre el documento completo)
  // y desactivar la combinación de correspondencia: el Word que sale es un
  // documento normal, sin vínculos al origen de datos de la plantilla.
  const combinado = aplanarCamposWord(head + bloques.join(SALTO_PAGINA) + cola);
  zip.updateFile('word/document.xml', Buffer.from(combinado, 'utf8'));
  desactivarMailMerge(zip);
  return { buffer: zip.toBuffer(), clientes };
}

module.exports = {
  generarPoderes,
  generarPoderesCombinado,
  camposSingular,
  camposPagoDirecto,
  sinPostProceso,
};
