/**
 * services/singular/demandas.js — Generación de Demandas Word (mail merge manual)
 *
 * Toma la plantilla DOCX (con placeholders «CAMPO») y genera un documento
 * por cliente en su carpeta de salida.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const AdmZip = require('adm-zip');

const { fmtCOP } = require('../../utils/numeros');
const { resolverCarpetaCedula } = require('../../utils/carpetas');

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Mapa «CAMPO» de la plantilla → valor de la fila de la Plantilla Singular
function buildFieldMap(fila) {
  return {
    TIPO_DE_JUZGADO:                    fila['TIPO DE JUZGADO']                    || '',
    CIUDAD_DE_JUZGADO:                  fila['CIUDAD DE JUZGADO']                  || '',
    CUANTIA:                            fila['CUANTIA']                             || '',
    OBLIGACION:                         fila['OBLIGACION']                          || '',
    OBLIGACIONES:                       fila['OBLIGACIONES']                        || fila['OBLIGACION'] || '',
    IDENTIFICACION:                     String(fila['IDENTIFICACION']               || ''),
    NOMBRE:                             fila['NOMBRE']                              || '',
    CAPITAL:                            fmtCOP(fila['CAPITAL']),
    INTERES:                            fmtCOP(fila['INTERES']),
    FECHA_MORA:                         fila['FECHA MORA']                          || '',
    FECHA_DE_ASIGNACION:                fila['FECHA DE ASIGNACION']                 || '',
    FECHA_DE_SUSCRIPCION:               fila['FECHA DE SUSCRIPCION']                || '',
    VALOR_CUANTIA:                      fmtCOP(fila['VALOR CUANTIA']),
    DIRECCION_DE_RESIDENCIA:            fila['DIRECCION DE RESIDENCIA']             || '',
    DIRECCION_ELECTRONICA:              fila['DIRECCION ELECTRONICA']               || '',
    NIT_EMPRESA_TT:                     String(fila['NIT EMPRESA TT']               || ''),
    NOMBRE_EMPRESA_TT:                  fila['NOMBRE EMPRESA TT']                   || '',
    DIRECCION_ELECTRONICA_EMPLEADOR:    fila['DIRECCION ELECTRONICA EMPLEADOR']     || '',
    PLACA:                              fila['PLACA']                               || '',
    SERVICIO:                           fila['SERVICIO']                            || '',
    CLASE:                              fila['CLASE']                               || '',
    MARCA:                              fila['MARCA']                               || '',
    LINEA:                              fila['LINEA']                               || '',
    MODELO:                             fila['MODELO']                              || '',
    COLOR:                              fila['COLOR']                               || '',
    SERIE:                              fila['SERIE']                               || '',
    MOTOR:                              fila['MOTOR']                               || '',
    CHASIS:                             fila['CHASIS']                              || '',
    TIPO_DE_CARROCERIA:                 fila['TIPO DE CARROCERIA']                  || '',
    STRIA_MCPAL_TTOyTTE:                fila['STRIA MCPAL\nTTOyTTE']               || '',
    DIRECCION_ELECTRONICA_DEL_TRANSITO: fila['DIRECCION ELECTRONICA DEL TRANSITO']  || '',
  };
}

function fillDocxTemplate(templateBuffer, fieldMap) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');

  // Pase 1: placeholders contiguos «CAMPO» dentro de un mismo run
  for (const [field, value] of Object.entries(fieldMap)) {
    xml = xml.split(`«${field}»`).join(xmlEscape(value));
  }

  // Pase 2: placeholders fragmentados por Word en varios runs.
  // Word puede partir «OBLIGACIONES» en <w:t>«OBLIGACION</w:t>...<w:t>ES</w:t>...<w:t>»</w:t>,
  // así el split del pase 1 nunca lo encuentra. Aquí se busca «...» permitiendo
  // etiquetas XML intercaladas; si el texto sin etiquetas coincide con un campo
  // conocido, se reemplaza el fragmento completo (las etiquetas intermedias se
  // consumen y el <w:t> exterior queda balanceado).
  xml = xml.replace(/«([^«»]{0,600}?)»/g, (match, inner) => {
    const fieldName = inner.replace(/<[^>]+>/g, '').trim();
    if (Object.prototype.hasOwnProperty.call(fieldMap, fieldName)) {
      return xmlEscape(fieldMap[fieldName]);
    }
    return match;
  });

  // Pase 3: concordancia singular/plural.
  // Con más de una obligación, "respalda la Obligación" → "respalda las Obligaciones"
  // en todos los lugares donde precede al listado de obligaciones.
  // La frase puede venir partida en varios runs ("respalda la" + " " + "Obligación"),
  // por eso se permite cualquier secuencia de etiquetas/espacios entre las palabras.
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

async function generarDemandasWord(filas, sacDocsDir, templateDocxPath) {
  if (!fs.existsSync(templateDocxPath)) {
    throw new Error(`Plantilla DOCX no encontrada: ${templateDocxPath}`);
  }
  const templateBuf = fs.readFileSync(templateDocxPath);
  const generados   = [];

  for (const fila of filas) {
    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    try {
      const fieldMap  = buildFieldMap(fila);
      const docxBuf   = fillDocxTemplate(templateBuf, fieldMap);
      const clientDir = resolverCarpetaCedula(sacDocsDir, cedula);
      if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
      const nombre  = (fila['NOMBRE'] || cedula).trim().replace(/[<>:"/\\|?*]/g, '_');
      const outFile = path.join(clientDir, `DEMANDA EJECUTIVA SINGULAR ${nombre} - ${cedula}.docx`);
      fs.writeFileSync(outFile, docxBuf);
      generados.push({ cedula, path: outFile });
      console.error(`[DEMANDA] ✓ ${cedula} → ${path.basename(outFile)}`);
    } catch (e) {
      console.error(`[DEMANDA] ✗ ${cedula}: ${e.message}`);
    }
  }
  return generados;
}

module.exports = { generarDemandasWord };
