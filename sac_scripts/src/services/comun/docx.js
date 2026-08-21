/**
 * services/comun/docx.js — Manipulación de documentos Word, sin reglas de negocio.
 *
 * Todo lo que aquí vive vale igual para una demanda de ejecutivo singular, para
 * un poder o para una solicitud de aprehensión: sustituir marcadores «CAMPO»,
 * estampar la firma del abogado y desarmar los MERGEFIELD de las plantillas que
 * vienen de un combinar correspondencia.
 *
 * Estaba repartido entre demandas.js y poderes.js del proceso singular. Se sacó
 * al separar los procesos: el de garantías mobiliarias necesita exactamente lo
 * mismo, y duplicarlo habría dejado dos copias que se van separando solas.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');

const config = require('../../config');

// Bytes de la firma (PNG), cacheados. null si no se encontró el archivo.
let _firmaBuf;








const ORDINALES = [
  'PRIMERO', 'SEGUNDO', 'TERCERO', 'CUARTO', 'QUINTO', 'SEXTO',
  'SÉPTIMO', 'OCTAVO', 'NOVENO', 'DÉCIMO', 'UNDÉCIMO', 'DUODÉCIMO',
  'DÉCIMO TERCERO', 'DÉCIMO CUARTO', 'DÉCIMO QUINTO',
];
const ORDINAL_RE = /(PRIMERO|SEGUNDO|TERCERO|CUARTO|QUINTO|SEXTO|S[ÉE]PTIMO|OCTAVO|NOVENO|UND[ÉE]CIMO|DUOD[ÉE]CIMO|D[ÉE]CIMO(?:\s+(?:TERCERO|CUARTO|QUINTO))?)/;



// ─── Helpers de párrafos ──────────────────────────────────────────────────────





// ─── Reemplazo de placeholders «CAMPO» ───────────────────────────────────────



// ─── Campos del documento ─────────────────────────────────────────────────────

// Placa corta: "LAM20F MATRICULADA EN EL ORGAN TRANSI…" → "LAM20F"
function placaCorta(placa) {
  const m = String(placa || '').trim().match(/^([A-Z0-9]{5,7})\b/i);
  return m ? m[1].toUpperCase() : String(placa || '').trim();
}

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

// ─── XML: escape y párrafos ──────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

// ─── MERGEFIELD (plantillas de combinar correspondencia) ─────────────────────

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

module.exports = {
  estamparFirma,
  xmlEscape,
  getParagraphs,
  textoDe,
  reemplazarCampos,
  aplanarCamposWord,
  desactivarMailMerge,
};
