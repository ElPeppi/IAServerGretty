/**
 * services/singular/demandas.js — Generación de Demandas Word (mail merge manual)
 *
 * Toma la plantilla DOCX (con placeholders «CAMPO») y genera un documento por
 * cliente en su carpeta de salida, aplicando las reglas del despacho:
 *
 *   PRUEBAS Y ANEXOS
 *     - Se elimina el punto del certificado del empleador (la numeración de la
 *       lista es automática de Word, se renumera sola).
 *     - Sin vehículos, se elimina también el punto de la consulta RUNT.
 *
 *   MEDIDAS CAUTELARES
 *     - El bloque de embargo de salario (TERCERO en la plantilla) se elimina siempre.
 *     - El bloque de embargo de vehículo (SEGUNDO en la plantilla) se replica una
 *       vez POR CADA vehículo del demandado, cada copia con los datos de su vehículo.
 *     - Sin vehículos, el bloque se elimina por completo.
 *     - Los ordinales (PRIMERO., SEGUNDO., …) se renumeran consecutivamente.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const AdmZip = require('adm-zip');

const { fmtCOP } = require('../../utils/numeros');
const { resolverCarpetaCedula } = require('../../utils/carpetas');

const ORDINALES = [
  'PRIMERO', 'SEGUNDO', 'TERCERO', 'CUARTO', 'QUINTO', 'SEXTO',
  'SÉPTIMO', 'OCTAVO', 'NOVENO', 'DÉCIMO', 'UNDÉCIMO', 'DUODÉCIMO',
  'DÉCIMO TERCERO', 'DÉCIMO CUARTO', 'DÉCIMO QUINTO',
];
const ORDINAL_RE = /(PRIMERO|SEGUNDO|TERCERO|CUARTO|QUINTO|SEXTO|S[ÉE]PTIMO|OCTAVO|NOVENO|UND[ÉE]CIMO|DUOD[ÉE]CIMO|D[ÉE]CIMO(?:\s+(?:TERCERO|CUARTO|QUINTO))?)/;

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Helpers de párrafos ──────────────────────────────────────────────────────

// Lista de párrafos top-level con offsets reales en el XML.
// (La plantilla no contiene tablas, así que el match plano es seguro.)
function getParagraphs(xml) {
  const paras = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    paras.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
  }
  return paras;
}

function textoDe(paraXml) {
  return ((paraXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
    .map(t => t.replace(/<[^>]+>/g, ''))
    .join(''))
    .trim();
}

// ─── Reemplazo de placeholders «CAMPO» ───────────────────────────────────────

// Pase 1: placeholders contiguos dentro de un mismo run.
// Pase 2: placeholders fragmentados por Word en varios runs («OBLIGACION + ES»…):
// se busca «…» permitiendo etiquetas XML intercaladas; si el texto sin etiquetas
// coincide con un campo conocido, se reemplaza el fragmento completo.
function reemplazarCampos(xml, fieldMap) {
  for (const [field, value] of Object.entries(fieldMap)) {
    xml = xml.split(`«${field}»`).join(xmlEscape(value));
  }
  xml = xml.replace(/«([^«»]{0,600}?)»/g, (match, inner) => {
    const fieldName = inner.replace(/<[^>]+>/g, '').trim();
    if (Object.prototype.hasOwnProperty.call(fieldMap, fieldName)) {
      return xmlEscape(fieldMap[fieldName]);
    }
    return match;
  });
  return xml;
}

// ─── Campos del documento ─────────────────────────────────────────────────────

// Placa corta: "LAM20F MATRICULADA EN EL ORGAN TRANSI…" → "LAM20F"
function placaCorta(placa) {
  const m = String(placa || '').trim().match(/^([A-Z0-9]{5,7})\b/i);
  return m ? m[1].toUpperCase() : String(placa || '').trim();
}

// Organismo de tránsito donde está matriculado el vehículo (cola del campo placa)
function transitoDe(placa) {
  const m = String(placa || '').match(/MATRICULADA?\s+EN\s+(?:EL\s+)?(.+)$/i);
  return m ? m[1].trim() : '';
}

// Campos por-vehículo para cada copia del bloque de medida cautelar
function vehiculoFieldMap(v) {
  return {
    PLACA:               placaCorta(v.placa),
    SERVICIO:            v.servicio       || '',
    CLASE:               v.clase          || '',
    MARCA:               v.marca          || '',
    LINEA:               v.linea          || '',
    MODELO:              v.modelo         || '',
    COLOR:               v.color          || '',
    SERIE:               v.serie          || '',
    MOTOR:               v.motor          || '',
    CHASIS:              v.chasis         || '',
    TIPO_DE_CARROCERIA:  v.tipoCarroceria || '',
    STRIA_MCPAL_TTOyTTE: transitoDe(v.placa),
  };
}

// Mapa «CAMPO» de la plantilla → valor de la fila de la Plantilla Singular
function buildFieldMap(fila, vehiculos = []) {
  // «PLACA» fuera de los bloques de vehículo (punto de pruebas "consulta RUNT"):
  // todas las placas cortas separadas por coma.
  const placasTodas = vehiculos.map(v => placaCorta(v.placa)).filter(Boolean).join(', ');

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
    FECHA_CERTIFICACION_DECEVAL:        fila['FECHA CERTIFICACION DECEVAL']         || '',
    VALOR_CUANTIA:                      fmtCOP(fila['VALOR CUANTIA']),
    DIRECCION_DE_RESIDENCIA:            fila['DIRECCION DE RESIDENCIA']             || '',
    DIRECCION_ELECTRONICA:              fila['DIRECCION ELECTRONICA']               || '',
    NIT_EMPRESA_TT:                     String(fila['NIT EMPRESA TT']               || ''),
    NOMBRE_EMPRESA_TT:                  fila['NOMBRE EMPRESA TT']                   || '',
    DIRECCION_ELECTRONICA_EMPLEADOR:    fila['DIRECCION ELECTRONICA EMPLEADOR']     || '',
    PLACA:                              placasTodas || fila['PLACA']                || '',
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

// ─── Transformación de secciones (medidas cautelares + pruebas) ──────────────

// Reestructura el documento según los vehículos del demandado:
//   - bloque vehículo replicado N veces (o eliminado si N = 0)
//   - bloque salario eliminado siempre
//   - punto de pruebas del empleador eliminado siempre
//   - punto de pruebas del RUNT eliminado si N = 0
//   - ordinales de medidas renumerados consecutivamente
function transformarSecciones(xml, vehiculos) {
  const paras = getParagraphs(xml);
  const conTexto = paras.map(p => ({ ...p, text: textoDe(p.xml) }));

  const idxTitulo = conTexto.findIndex(p => /^MEDIDAS\s+CAUTELARES$/i.test(p.text));
  const idxVeh    = conTexto.findIndex((p, i) => i > idxTitulo && idxTitulo >= 0
    && /^(?:PRIMERO|SEGUNDO|TERCERO|CUARTO)\.\s*-\s*Se sirva ordenar EMBARGO y SECUESTRO del\s+Veh[ií]culo/i.test(p.text));
  const idxSalario = conTexto.findIndex((p, i) => i > Math.max(idxTitulo, idxVeh)
    && /^(?:SEGUNDO|TERCERO|CUARTO)\.\s*-\s*Se sirva ordenar EMBARGO del\s*\(?\s*los?\s*\)?\s*salario/i.test(p.text));
  const idxDineros = conTexto.findIndex((p, i) => i > Math.max(idxTitulo, idxVeh, idxSalario)
    && /^(?:TERCERO|CUARTO|QUINTO)\.\s*-\s*El embargo y secuestro de los dineros/i.test(p.text));

  const idxPruebaEmpleador = conTexto.findIndex(p =>
    /Certificado de existencia y representaci[oó]n legal del empleador/i.test(p.text));
  const idxPruebaRunt = conTexto.findIndex(p =>
    /Copia consulta automotores del RUNT/i.test(p.text));

  // Ediciones como rangos [start, end) + contenido de reemplazo.
  // Se aplican de mayor a menor offset para no invalidar índices.
  const ediciones = [];

  if (idxVeh >= 0 && idxSalario > idxVeh && idxDineros > idxSalario) {
    const startVeh     = conTexto[idxVeh].start;
    const startSalario = conTexto[idxSalario].start;
    const startDineros = conTexto[idxDineros].start;

    // Bloque vehículo completo: [inicio SEGUNDO, inicio TERCERO)
    const bloqueVeh = xml.slice(startVeh, startSalario);

    // Una copia del bloque por vehículo (con sus datos); sin vehículos → nada.
    // El bloque de salario ([TERCERO, CUARTO)) se elimina SIEMPRE.
    const copias = vehiculos
      .map(v => reemplazarCampos(bloqueVeh, vehiculoFieldMap(v)))
      .join('');
    ediciones.push({ start: startVeh, end: startDineros, contenido: copias });
  } else {
    console.error('[DEMANDA] No se localizaron los bloques de medidas cautelares — se omite la reestructuración');
  }

  // Punto de pruebas del empleador → fuera siempre (numeración automática de Word)
  if (idxPruebaEmpleador >= 0) {
    ediciones.push({ start: conTexto[idxPruebaEmpleador].start, end: conTexto[idxPruebaEmpleador].end, contenido: '' });
  }
  // Punto de pruebas del RUNT → fuera si no hay vehículos
  if (vehiculos.length === 0 && idxPruebaRunt >= 0) {
    ediciones.push({ start: conTexto[idxPruebaRunt].start, end: conTexto[idxPruebaRunt].end, contenido: '' });
  }

  ediciones.sort((a, b) => b.start - a.start);
  for (const e of ediciones) {
    xml = xml.slice(0, e.start) + e.contenido + xml.slice(e.end);
  }

  // ── Renumerar ordinales de las medidas cautelares ──────────────────────────
  // Tras las ediciones se re-parsean los párrafos: cada medida (párrafo que
  // empieza con "ORDINAL. -" después del título) recibe su ordinal por posición.
  const parasFinal = getParagraphs(xml);
  let offsetTitulo = -1;
  for (const p of parasFinal) {
    if (/^MEDIDAS\s+CAUTELARES$/i.test(textoDe(p.xml))) { offsetTitulo = p.start; break; }
  }

  if (offsetTitulo >= 0) {
    let k = 0;
    let resultado = '';
    let cursor = 0;
    for (const p of parasFinal) {
      if (p.start < offsetTitulo) continue;
      const texto = textoDe(p.xml);
      const inicioMedida = new RegExp('^' + ORDINAL_RE.source + '\\.\\s*-').test(texto);
      if (!inicioMedida) continue;

      const nuevoOrdinal = ORDINALES[k++] || `MEDIDA ${k}`;
      // Reemplazar la PRIMERA ocurrencia del ordinal dentro del XML del párrafo
      // (los ordinales van contiguos al inicio del primer run con texto).
      const nuevoParaXml = p.xml.replace(ORDINAL_RE, nuevoOrdinal);

      resultado += xml.slice(cursor, p.start) + nuevoParaXml;
      cursor = p.end;
    }
    xml = resultado + xml.slice(cursor);
  }

  return xml;
}

// ─── Generación del DOCX ──────────────────────────────────────────────────────

function fillDocxTemplate(templateBuffer, fieldMap, vehiculos = []) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');

  // 1) Reestructurar secciones según vehículos (medidas, pruebas, ordinales)
  xml = transformarSecciones(xml, vehiculos);

  // 2) Pase global de placeholders (lo que quede fuera de los bloques por-vehículo)
  xml = reemplazarCampos(xml, fieldMap);

  // 3) Concordancia singular/plural: con más de una obligación,
  //    "respalda la Obligación" → "respalda las Obligaciones".
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

// items: [{ fila, vehiculos }] — fila de la Plantilla Singular + vehículos REALES
// del cliente (array vacío si no tiene).
async function generarDemandasWord(items, sacDocsDir, templateDocxPath) {
  if (!fs.existsSync(templateDocxPath)) {
    throw new Error(`Plantilla DOCX no encontrada: ${templateDocxPath}`);
  }
  const templateBuf = fs.readFileSync(templateDocxPath);
  const generados   = [];

  for (const item of items) {
    // Compatibilidad: aceptar tanto { fila, vehiculos } como la fila plana
    const fila      = item.fila || item;
    const vehiculos = Array.isArray(item.vehiculos) ? item.vehiculos : [];

    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    try {
      const fieldMap  = buildFieldMap(fila, vehiculos);
      const docxBuf   = fillDocxTemplate(templateBuf, fieldMap, vehiculos);
      const clientDir = resolverCarpetaCedula(sacDocsDir, cedula);
      if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
      const nombre  = (fila['NOMBRE'] || cedula).trim().replace(/[<>:"/\\|?*]/g, '_');
      const outFile = path.join(clientDir, `DEMANDA EJECUTIVA SINGULAR ${nombre} - ${cedula}.docx`);
      fs.writeFileSync(outFile, docxBuf);
      generados.push({ cedula, path: outFile });
      console.error(`[DEMANDA] ✓ ${cedula} → ${path.basename(outFile)} (${vehiculos.length} vehículo(s))`);
    } catch (e) {
      console.error(`[DEMANDA] ✗ ${cedula}: ${e.message}`);
    }
  }
  return generados;
}

module.exports = { generarDemandasWord };
