/**
 * firmaStamp — estampa la firma del abogado en el .docx de una demanda, AL FIRMAR.
 *
 * La plantilla NO trae imagen de firma en el cuerpo (los bloques "Atentamente," y
 * "Del señor Juez," son solo texto). Aquí se INSERTA `Firma.png` como imagen inline
 * justo encima de cada bloque de nombre del abogado, sobre una COPIA del docx (el
 * documento guardado queda sin firma hasta que se firma). Inline (no flotante) para
 * que LibreOffice la conserve al convertir a PDF.
 *
 * Port de `sac_scripts/src/services/singular/demandas.js` `estamparFirma()`.
 */
import AdmZip from 'adm-zip';

const NOMBRE_FIRMANTE = 'JAIRO ENRIQUE RAMOS LAZARO';
const ANCLAS = ['Atentamente,', 'Del señor Juez'];

// Ancho/alto (px) + DPI de un PNG (IHDR + pHYs). Sin pHYs → 96 dpi (default de Word).
// Con el DPI real se calcula el tamaño ORIGINAL de la imagen (como al insertarla en Word).
function pngInfo(buf: Buffer): { w: number; h: number; dpiX: number; dpiY: number } | null {
  if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  let dpiX = 96;
  let dpiY = 96;
  let off = 8; // saltar la firma PNG (8 bytes)
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'pHYs') {
      const ppuX = buf.readUInt32BE(off + 8);
      const ppuY = buf.readUInt32BE(off + 12);
      if (buf[off + 16] === 1) { dpiX = ppuX * 0.0254; dpiY = ppuY * 0.0254; } // unidad = metros
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return { w, h, dpiX: dpiX || 96, dpiY: dpiY || 96 };
}

// Párrafo con la firma como imagen INLINE (r:embed → relId). Namespaces declarados
// en el propio elemento para no depender de las declaraciones del root del document.
function firmaParagraphXml(relId: string, id: number, cx: number, cy: number): string {
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

// Inicio del <w:p ...> o <w:p> que contiene la posición dada.
function inicioParrafo(s: string, pos: number): number {
  return Math.max(s.lastIndexOf('<w:p>', pos), s.lastIndexOf('<w:p ', pos));
}

/**
 * Devuelve los bytes de un .docx con la firma estampada encima de cada bloque de
 * nombre del abogado. Si no encuentra las anclas, devuelve el docx sin cambios.
 */
export function estamparFirmaDocx(docxBuffer: Buffer, firmaBuffer: Buffer): Buffer {
  const zip = new AdmZip(docxBuffer);

  let xml: string;
  try { xml = zip.readAsText('word/document.xml'); } catch { return docxBuffer; }

  const presentes = ANCLAS.filter((a) => xml.includes(a));
  if (!presentes.length) return docxBuffer; // sin bloques de firma → sin cambios

  // Tamaño ORIGINAL de la firma (px / DPI → pulgadas → EMU, 1" = 914400).
  const info = pngInfo(firmaBuffer) || { w: 234, h: 253, dpiX: 220, dpiY: 220 };
  const EMU = 914400;
  const cx = Math.round((info.w / info.dpiX) * EMU);
  const cy = Math.round((info.h / info.dpiY) * EMU);

  // 1) Media nueva con la firma.
  const mediaName = 'word/media/firma_ai.png';
  if (zip.getEntry(mediaName)) zip.updateFile(mediaName, firmaBuffer);
  else zip.addFile(mediaName, firmaBuffer);

  // 2) Relación imagen en document.xml.rels.
  const relsPath = 'word/_rels/document.xml.rels';
  const relId = 'rIdFirmaAI';
  let rels = '';
  try { rels = zip.readAsText(relsPath); } catch { return docxBuffer; }
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
  const tieneContenido = (p: string) => /<w:t[ >]/.test(p) || /<w:drawing\b/.test(p);
  let id = 9001;
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
  }
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));

  return zip.toBuffer();
}
