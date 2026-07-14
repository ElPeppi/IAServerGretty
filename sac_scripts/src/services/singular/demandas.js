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

const config = require('../../config');
const { fmtCOP } = require('../../utils/numeros');
const { resolverCarpetaCedula } = require('../../utils/carpetas');

// Bytes de la firma (PNG), cacheados. null si no se encontró el archivo.
let _firmaBuf;
function cargarFirma() {
  if (_firmaBuf !== undefined) return _firmaBuf;
  try {
    _firmaBuf = fs.readFileSync(config.FIRMA_PATH);
    console.error(`[FIRMA] imagen cargada: ${config.FIRMA_PATH} (${_firmaBuf.length} bytes)`);
  } catch (e) {
    _firmaBuf = null;
    console.error(`[FIRMA] no se encontró la imagen de la firma (${config.FIRMA_PATH}): ${e.message}`);
  }
  return _firmaBuf;
}

// Ancho/alto (px) + DPI de un PNG (IHDR + pHYs). Sin pHYs → 96 dpi. Con el DPI real
// se obtiene el tamaño ORIGINAL de la imagen (como al insertarla en Word).
function pngInfo(buf) {
  if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  let dpiX = 96, dpiY = 96, off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'pHYs') {
      const ppuX = buf.readUInt32BE(off + 8), ppuY = buf.readUInt32BE(off + 12);
      if (buf[off + 16] === 1) { dpiX = ppuX * 0.0254; dpiY = ppuY * 0.0254; }
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return { w, h, dpiX: dpiX || 96, dpiY: dpiY || 96 };
}

// Párrafo con la firma como imagen INLINE (r:embed → relId). Los namespaces wp/r/a/pic
// se declaran en el propio elemento para no depender de las declaraciones del root.
function firmaParagraphXml(relId, id, cx, cy) {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  return `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline xmlns:wp="${WP}" xmlns:r="${R}" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="FirmaAI ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}">` +
    `<pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="${id}" name="FirmaAI ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/**
 * Estampa la firma (Firma.png) en la demanda INSERTÁNDOLA como imagen inline
 * justo debajo de cada bloque de firma ("Atentamente," y "Del señor Juez,").
 *
 * La plantilla NO trae una imagen de firma anclada en el cuerpo (los bloques son
 * solo texto), así que no hay un <w:drawing> que reemplazar: se agrega la firma
 * como media nueva + su relación y se inyecta un párrafo con la imagen. Inline
 * (no flotante) para que LibreOffice la conserve al convertir a PDF.
 */
function estamparFirma(zip) {
  const firma = cargarFirma();
  if (!firma) return; // sin firma → se deja la plantilla tal cual

  let xml;
  try { xml = zip.readAsText('word/document.xml'); } catch { return; }

  const anclas = ['Atentamente,', 'Del señor Juez'];
  const presentes = anclas.filter((a) => xml.includes(a));
  if (!presentes.length) { console.error('[FIRMA] no se hallaron los bloques de firma; no se estampó'); return; }

  // Tamaño ORIGINAL de la firma (px / DPI → pulgadas → EMU, 1" = 914400).
  const info = pngInfo(firma) || { w: 234, h: 253, dpiX: 220, dpiY: 220 };
  const EMU = 914400;
  const cx = Math.round((info.w / info.dpiX) * EMU);
  const cy = Math.round((info.h / info.dpiY) * EMU);

  // 1) Media nueva con la firma.
  const mediaName = 'word/media/firma_ai.png';
  if (zip.getEntry(mediaName)) zip.updateFile(mediaName, firma);
  else zip.addFile(mediaName, firma);

  // 2) Relación imagen en document.xml.rels.
  const relsPath = 'word/_rels/document.xml.rels';
  const relId = 'rIdFirmaAI';
  let rels = '';
  try { rels = zip.readAsText(relsPath); } catch { console.error('[FIRMA] sin document.xml.rels'); return; }
  if (!rels.includes(`Id="${relId}"`)) {
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/firma_ai.png"/></Relationships>`
    );
    zip.updateFile(relsPath, Buffer.from(rels, 'utf8'));
  }

  // 3) Content type de PNG (por si la plantilla no lo tuviera ya).
  try {
    let ct = zip.readAsText('[Content_Types].xml');
    if (!/Extension="png"/i.test(ct)) {
      ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
      zip.updateFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
    }
  } catch { /* no crítico */ }

  // 4) Pegar la firma JUSTO DESPUÉS del texto anterior ("Atentamente," / "Del señor
  //    Juez,"), eliminando los párrafos VACÍOS que la plantilla deja entre ese texto
  //    y el bloque de nombre (esos vacíos causaban el hueco grande). Resultado:
  //    ancla → firma → nombre, compacto. Respaldo: tras el párrafo del ancla.
  const NOMBRE_FIRMANTE = 'JAIRO ENRIQUE RAMOS LAZARO';
  // Inicio del <w:p ...> o <w:p> que contiene la posición dada.
  const inicioParrafo = (s, pos) => Math.max(s.lastIndexOf('<w:p>', pos), s.lastIndexOf('<w:p ', pos));
  const tieneContenido = (p) => /<w:t[ >]/.test(p) || /<w:drawing\b/.test(p);
  let id = 9001;
  let n = 0;
  for (const ancla of presentes) {
    const ai = xml.indexOf(ancla);
    if (ai < 0) continue;
    const anchorClose = xml.indexOf('</w:p>', ai);
    if (anchorClose < 0) continue;
    const afterAnchor = anchorClose + '</w:p>'.length;
    const firmaPara = firmaParagraphXml(relId, id++, cx, cy);
    const nameIdx = xml.indexOf(NOMBRE_FIRMANTE, afterAnchor);
    const nameStart = nameIdx >= 0 ? inicioParrafo(xml, nameIdx) : -1;
    if (nameStart > afterAnchor) {
      const between = xml
        .slice(afterAnchor, nameStart)
        .replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => (tieneContenido(p) ? p : ''));
      xml = xml.slice(0, afterAnchor) + firmaPara + between + xml.slice(nameStart);
    } else {
      xml = xml.slice(0, afterAnchor) + firmaPara + xml.slice(afterAnchor);
    }
    n++;
  }
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  console.error(`[FIRMA] firma insertada (inline) en ${n} bloque(s)`);
}

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
    // Autoridad de tránsito: la del RUNT (más limpia) o, si no, la del texto de la placa
    STRIA_MCPAL_TTOyTTE: v.runtAutoridad || transitoDe(v.placa),
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
  };
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
  const esFinandina = String(tipoPagare || '').toUpperCase() === 'FINANDINA';
  for (const p of conTexto) {
    const quitar = esFinandina
      ? /DECEVAL/i.test(p.text)
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

module.exports = { generarDemandasWord, buildFieldMap, reemplazarCampos, estamparFirma };
