/**
 * services/comun/poderes.js — Motor de generación de poderes, sin proceso propio.
 *
 * Sabe partir la plantilla del poder, repetir su cuerpo una vez por cliente y
 * volver a armar el .docx. NO sabe qué marcadores lleva cada poder: eso lo pone
 * quien llama, pasando `construirCampos`. Así el ejecutivo singular y el trámite
 * de pago directo comparten el motor y no la plantilla ni los campos.
 *
 * Ver los constructores en finandina/singular/poderes.js y
 * finandina/garantia/poderes.js.
 */

'use strict';

const fs     = require('fs');
const AdmZip = require('adm-zip');

const { reemplazarCampos, aplanarCamposWord, desactivarMailMerge } = require('./docx');

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
  // Cómo se arma el mapa «CAMPO»→valor de cada cliente lo decide el proceso que
  // llama: no hay valor por defecto a propósito, para que añadir un proceso nuevo
  // no herede en silencio los campos del ejecutivo singular.
  const construirCampos = opts.construirCampos;
  if (typeof construirCampos !== 'function') {
    throw new Error('generarPoderesCombinado necesita opts.construirCampos');
  }
  const postProcesar = opts.postProcesar || ((xml) => xml);

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

module.exports = { fillPoder, generarPoderesCombinado };
