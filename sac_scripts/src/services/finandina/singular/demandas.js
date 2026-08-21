/**
 * services/finandina/singular/demandas.js — Generación de Demandas Word (mail merge manual)
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

const config = require('../../../config');
const { fmtCOP } = require('../../../utils/numeros');
const { resolverCarpetaCedula } = require('../../../utils/carpetas');
const {
  estamparFirma, xmlEscape, getParagraphs, textoDe, reemplazarCampos,
} = require('../../comun/docx');

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
    // Autoridad de tránsito: la del RUNT (más limpia) o, si no, la del texto de la placa
    STRIA_MCPAL_TTOyTTE: v.runtAutoridad || transitoDe(v.placa),
  };
}

// Mapa «CAMPO» de la plantilla → valor de la fila de la Plantilla Singular
// Marcador de dato faltante. Va en el documento allí donde el motor no pudo
// determinar el valor, para que quien revise vea de una el hueco a llenar.
const FALTANTE = '#####';

function buildFieldMap(fila, vehiculos = []) {
  // «PLACA» fuera de los bloques de vehículo (punto de pruebas "consulta RUNT"):
  // todas las placas cortas separadas por coma.
  const placasTodas = vehiculos.map(v => placaCorta(v.placa)).filter(Boolean).join(', ');

  // Todo campo que quede vacío se rellena con FALTANTE (ver marcarFaltantes abajo):
  // los bloques cuyos datos no aplican ya fueron eliminados por transformarSecciones,
  // así que un placeholder vacío que llegue hasta aquí es un dato que SÍ falta.
  return marcarFaltantes({
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
    // Si no se cuenta con la dirección electrónica del empleador (que sale de la
    // Cámara de Comercio), se deja "#####" para que se sobreentienda que falta.
    DIRECCION_ELECTRONICA_EMPLEADOR:    fila['DIRECCION ELECTRONICA EMPLEADOR']     || '#####',
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
  });
}

// Sustituye por FALTANTE los campos que quedaron vacíos. Se excluyen:
//   · los de vehículo → su bloque se elimina entero si no hay vehículos;
//   · NOMBRE/NIT_EMPRESA_TT → fillDocxTemplate decide con ELLOS si hay info
//     laboral (`tieneEmpresa`); marcarlos haría que el bloque de embargo de
//     salario nunca se elimine.
const SIN_MARCAR = new Set([
  'PLACA', 'SERVICIO', 'CLASE', 'MARCA', 'LINEA', 'MODELO', 'COLOR',
  'SERIE', 'MOTOR', 'CHASIS', 'TIPO_DE_CARROCERIA',
  'NOMBRE_EMPRESA_TT', 'NIT_EMPRESA_TT',
]);
function marcarFaltantes(map) {
  for (const [k, v] of Object.entries(map)) {
    if (SIN_MARCAR.has(k)) continue;
    if (String(v ?? '').trim() === '') map[k] = FALTANTE;
  }
  return map;
}

// ─── Transformación de secciones (medidas cautelares + pruebas) ──────────────

// Reestructura el documento según los datos disponibles del demandado:
//   VEHÍCULOS (tiene vehículos):
//     - bloque vehículo replicado N veces (o eliminado si N = 0)
//     - punto de pruebas del RUNT (nro. 4) eliminado si N = 0
//   EMPRESA (tiene empresa + NIT):
//     - bloque embargo de salario eliminado si NO hay info laboral
//     - punto de pruebas del empleador (nro. 5) eliminado si NO hay info laboral
//   - ordinales de medidas renumerados consecutivamente
function transformarSecciones(xml, vehiculos, tieneEmpresa, esBarranquilla, tieneInmueble, tipoPagare) {
  const paras = getParagraphs(xml);
  const conTexto = paras.map(p => ({ ...p, text: textoDe(p.xml) }));

  // COMPETENCIA Y CUANTIA: si el demandado NO es de Barranquilla, el párrafo
  // termina en "...del domicilio del demandado." (se quita el nombre y la
  // dirección resaltados que van después).
  const idxCompetencia = conTexto.findIndex(p => /del domicilio del demandado/i.test(p.text));

  const idxTitulo = conTexto.findIndex(p => /^MEDIDAS\s+CAUTELARES$/i.test(p.text));
  // Bloque inmueble (PRIMERO): embargo y secuestro de inmuebles
  const idxInmueble = conTexto.findIndex((p, i) => i > idxTitulo && idxTitulo >= 0
    && /^(?:PRIMERO|SEGUNDO)\.\s*-\s*Se sirva ordenar EMBARGO y SECUESTRO del\s*\(?\s*los?\s*\)?\s*inmueble/i.test(p.text));
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

  // Bloque inmueble (PRIMERO): [inicio PRIMERO, inicio del bloque vehículo).
  // Se elimina completo si el demandado no tiene inmueble.
  if (!tieneInmueble && idxInmueble >= 0 && idxVeh > idxInmueble) {
    ediciones.push({ start: conTexto[idxInmueble].start, end: conTexto[idxVeh].start, contenido: '' });
  }

  if (idxVeh >= 0 && idxSalario > idxVeh && idxDineros > idxSalario) {
    const startVeh     = conTexto[idxVeh].start;
    const startSalario = conTexto[idxSalario].start;
    const startDineros = conTexto[idxDineros].start;

    // Bloque vehículo: [inicio SEGUNDO, inicio TERCERO).
    // Una copia por vehículo (con sus datos); sin vehículos → se elimina.
    const bloqueVeh = xml.slice(startVeh, startSalario);
    const copias = vehiculos
      .map(v => reemplazarCampos(bloqueVeh, vehiculoFieldMap(v)))
      .join('');
    ediciones.push({ start: startVeh, end: startSalario, contenido: copias });

    // Bloque embargo de salario: [inicio TERCERO, inicio CUARTO).
    // Se MANTIENE si hay empresa+NIT (se llena en el pase global de campos),
    // se elimina si no tenemos info laboral del demandado.
    if (!tieneEmpresa) {
      ediciones.push({ start: startSalario, end: startDineros, contenido: '' });
    }
  } else {
    console.error('[DEMANDA] No se localizaron los bloques de medidas cautelares — se omite la reestructuración');
  }

  // Punto de pruebas del empleador (nro. 5) → fuera solo si no hay info laboral
  if (!tieneEmpresa && idxPruebaEmpleador >= 0) {
    ediciones.push({ start: conTexto[idxPruebaEmpleador].start, end: conTexto[idxPruebaEmpleador].end, contenido: '' });
  }
  // Punto de pruebas del RUNT (nro. 4) → fuera si no hay vehículos
  if (vehiculos.length === 0 && idxPruebaRunt >= 0) {
    ediciones.push({ start: conTexto[idxPruebaRunt].start, end: conTexto[idxPruebaRunt].end, contenido: '' });
  }

  // Custodia / título valor: la plantilla trae párrafos alternativos según dónde
  // esté custodiado el pagaré (DECEVAL vs BANCO FINANDINA). Mismo banco, misma
  // plantilla, pero distinto tipo de pagaré:
  //   • DECEVAL   (pagaré con texto)     → se quitan las variantes de "custodia
  //     en BANCO FINANDINA"; quedan las de DECEVAL (incluido el certificado
  //     desmaterializado con FECHA_CERTIFICACION_DECEVAL).
  //   • FINANDINA (pagaré escaneado)     → se quitan TODOS los párrafos que
  //     mencionen DECEVAL (custodia + certificado desmaterializado); quedan las
  //     variantes de custodia en BANCO FINANDINA.
  //   El párrafo que describe el título valor "CREADO EN FORMA ELECTRÓNICA
  //   (LEY 527 DE 1999) … ANOTACIÓN EN CUENTA" solo aplica al pagaré
  //   desmaterializado; no nombra a DECEVAL, así que se quita aparte.
  const esFinandina = String(tipoPagare || '').toUpperCase() === 'FINANDINA';
  const RE_DESMATERIALIZADO = /CREADO\s+EN\s+FORMA\s+ELECTR[OÓ]NICA/i;
  for (const p of conTexto) {
    const quitar = esFinandina
      ? (/DECEVAL/i.test(p.text) || RE_DESMATERIALIZADO.test(p.text))
      : /custodia\s+en\s+BANCO\s+FINANDINA/i.test(p.text);
    if (quitar) ediciones.push({ start: p.start, end: p.end, contenido: '' });
  }

  // COMPETENCIA Y CUANTIA: si NO es de Barranquilla, recortar el párrafo en
  // "...del domicilio del demandado." (quitar «NOMBRE» «DIRECCION_DE_RESIDENCIA»)
  if (!esBarranquilla && idxCompetencia >= 0) {
    const p = conTexto[idxCompetencia];
    const marker = 'del domicilio del demandado';
    const mi = p.xml.indexOf(marker);
    if (mi >= 0) {
      // Conservar todo hasta el marcador, cerrar la frase con punto y el párrafo.
      const nuevoPara = p.xml.slice(0, mi) + 'del domicilio del demandado.</w:t></w:r></w:p>';
      ediciones.push({ start: p.start, end: p.end, contenido: nuevoPara });
    }
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

function fillDocxTemplate(templateBuffer, fieldMap, vehiculos = [], tieneInmueble = false, camaraEmpleador = '', tipoPagare = 'DECEVAL', datacreditoCorreos = true) {
  const zip = new AdmZip(templateBuffer);
  let xml = zip.readAsText('word/document.xml');

  // Hay info laboral solo si tenemos AMBOS: nombre de empresa y NIT
  const tieneEmpresa = !!(String(fieldMap.NOMBRE_EMPRESA_TT || '').trim()
                       && String(fieldMap.NIT_EMPRESA_TT || '').trim());

  // ¿El demandado es de Barranquilla? (ciudad del cliente = CIUDAD_DE_JUZGADO)
  const ciudadNorm = String(fieldMap.CIUDAD_DE_JUZGADO || '')
    .toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const esBarranquilla = ciudadNorm === 'BARRANQUILLA';

  // 1) Reestructurar secciones según inmueble, vehículos, empresa, ciudad y tipo de pagaré
  xml = transformarSecciones(xml, vehiculos, tieneEmpresa, esBarranquilla, tieneInmueble, tipoPagare);

  // 2) Pase global de placeholders (lo que quede fuera de los bloques por-vehículo)
  xml = reemplazarCampos(xml, fieldMap);

  // 2-bis) Cámara de Comercio del empleador (punto 5 de pruebas): rellenar el
  // "-----" (lugar de expedición) tras "Cámara de Comercio de" con la ciudad
  // obtenida del RUES. Si no se encontró, se deja "#####" para que se
  // sobreentienda que falta ese dato.
  // (No afecta la línea de BANCO FINANDINA, que ya dice "de Bogotá".)
  const lugarExpedicion = camaraEmpleador || '#####';
  xml = xml.replace(/(C[áa]mara de Comercio de\s*)-{2,}/g, `$1${xmlEscape(lugarExpedicion)}`);

  // 2-ter) Si el DataCrédito NO trae la tabla de correos, no se menciona en el
  // punto de pruebas "...del sistema SAC y de Datacrédito...". Los runs vienen
  // separados: <w:t>SAC y de </w:t> … <w:t>Datacrédito</w:t> → se editan ambos.
  if (!datacreditoCorreos) {
    xml = xml.replace(/(<w:t\b[^>]*>)([^<]*?)SAC y de\s*([^<]*?)(<\/w:t>)/g, '$1$2SAC$3$4');
    xml = xml.replace(/(<w:t\b[^>]*>)([^<]*?)Datacr[ée]dito([^<]*?)(<\/w:t>)/g, '$1$2$3$4');
  }

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

  // 4) La firma NO se estampa al generar: el docx queda limpio para revisar/editar.
  //    La firma se aplica AL FIRMAR (backend: SignedPdfService + firmaStamp), sobre
  //    una copia, y ahí se une con los anexos. (estamparFirma se conserva por si se
  //    quisiera volver a estampar en generación.)
  // estamparFirma(zip);

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
    const fila            = item.fila || item;
    const vehiculos       = Array.isArray(item.vehiculos) ? item.vehiculos : [];
    const tieneInmueble   = !!item.tieneInmueble;
    const camaraEmpleador = item.camaraEmpleador || '';
    const tipoPagare      = item.tipoPagare || 'DECEVAL';
    const datacreditoCorreos = item.datacreditoCorreos !== false;

    const cedula = String(fila['IDENTIFICACION'] || '').trim();
    if (!cedula) continue;
    try {
      const fieldMap  = buildFieldMap(fila, vehiculos);
      const docxBuf   = fillDocxTemplate(templateBuf, fieldMap, vehiculos, tieneInmueble, camaraEmpleador, tipoPagare, datacreditoCorreos);
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

module.exports = { generarDemandasWord, buildFieldMap };
