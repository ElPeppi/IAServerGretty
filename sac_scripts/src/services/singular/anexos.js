/**
 * services/singular/anexos.js — Genera ANEXOS.pdf por cliente
 *
 * Une, en un solo PDF, las pruebas y anexos de la demanda, cada uno precedido
 * por su carátula ("ANEXO N ..."). La NUMERACIÓN es DINÁMICA y debe coincidir con
 * la lista de pruebas de la demanda (que añade/quita puntos según los datos):
 *   Poder            → correo del banco con el poder del cliente sobrepuesto
 *   Pagaré           → PAGARE/DECEVAL del cliente
 *   Pantallazo SAC   → SAC_*_DIRYTEL + DataCrédito (completo, todas las páginas)
 *   RUNT             → SOLO si hay vehículos (consulta automotores; placeholder)
 *   CCO empleador    → SOLO si hay empresa+NIT (cámara de comercio del empleador;
 *                      placeholder si no existe el PDF, para que se pueda añadir)
 *   CCO J Ramos      → certificado más reciente en DEMANDAS
 *   SIRNA            → registro nacional de abogados (DEMANDAS)
 *   Super Financiera → certificado más reciente en FINANDINA
 *   CCO Finandina    → cámara de comercio Finandina comprimida (FINANDINA)
 *
 * La carátula de CADA anexo va SIEMPRE (aunque falte el documento), para dejar el
 * espacio numerado donde insertarlo. El correo del poder se toma del que sube la
 * web (correoPoderBuffer) y, si no llega, del más reciente en el folder PODERES
 * como respaldo; si además existe el poder .docx del cliente, se sobrepone en el
 * cuerpo del correo. Se guarda en la carpeta del cliente.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const AdmZip = require('adm-zip');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const config = require('../../config');
const { resolverCarpetaCedula } = require('../../utils/carpetas');

// Descripciones de carátula (tomadas de ANEXO SINGULAR.pdf). Sin número fijo:
// el número se asigna dinámicamente al armar el PDF (ver generarAnexos).
const DESC = {
  poder:     'Poder especial para obrar conferido a la sociedad J RAMOS ABOGADOS Y ASOCIADOS S.A.S. otorgado por BANCO FINANDINA S. A. BIC conforme a la ley 2213 del 13 de junio de 2022',
  pagare:    'Pagare(s) No. {OBLIGACION}', // se completa con "Que respalda la(s) obligación(es) …" al armar
  sac:       'Pantallazo información del deudor del sistema SAC y de Datacrédito entregado por BANCO FINANDINA S. A. BIC, donde se evidencia la(s) dirección(es) electrónica(s) de la parte demandada, conforme al artículo 6 de la ley No. 2213 del 13 de junio de 2022',
  // Variante sin DataCrédito (cuando éste no trae la tabla de correos):
  sacSinDc:  'Pantallazo información del deudor del sistema SAC entregado por BANCO FINANDINA S. A. BIC, donde se evidencia la(s) dirección(es) electrónica(s) de la parte demandada, conforme al artículo 6 de la ley No. 2213 del 13 de junio de 2022',
  runt:      'Copia consulta automotores del RUNT de la parte demandada, conforme a las medidas cautelares solicitadas',
  empleador: 'Certificado de existencia y representación legal del empleador {EMPRESA}, expedido por la Cámara de Comercio de {CAMARA}, solicitado en el escrito de medidas cautelares',
  ccoJRamos: 'Certificado de existencia y representación legal de la sociedad J RAMOS ABOGADOS Y ASOCIADOS S.A.S, expedido por la cámara de comercio de Barranquilla',
  sirna:     'Certificado de registro Nacional de abogados del abogado JAIRO ENRIQUE RAMOS LAZARO para demostrar el requisito para actuar de la Sociedad J RAMOS ABOGADOS S.A.S. de conformidad con el inciso primero del artículo 75 del C.G.P',
  superfin:  'Certificado de existencia y representación legal de BANCO FINANDINA S. A. BIC expedido por Superintendencia Financiera de Colombia',
  ccoFin:    'Certificado de Cámara de Comercio de BANCO FINANDINA S. A. BIC. expedido por la Cámara de Comercio de Bogotá',
};

// ─── Certificados compartidos (iguales para todos los clientes) ──────────────

function archivoMasReciente(dir, predicado) {
  let best = null, bestMtime = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.pdf$/i.test(f) || !predicado(f)) continue;
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = path.join(dir, f); }
    }
  } catch (e) {
    console.error(`[ANEXOS] No se pudo leer ${dir}: ${e.message}`);
  }
  return best;
}

// Igual que archivoMasReciente pero recorre subcarpetas (el correo del poder
// vive en PODERES/{año}/...).
function archivoMasRecienteRec(dir, predicado) {
  let best = null, bestMtime = -1;
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.pdf$/i.test(e.name) && predicado(e.name)) {
        try { const st = fs.statSync(p); if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; } }
        catch (_) {}
      }
    }
  })(dir);
  return best;
}

// Los certificados compartidos se resuelven una vez y se reusan durante el lote:
// `archivoMasRecienteRec` recorre PODERES entero y se llama UNA VEZ POR CLIENTE.
//
// Pero el caché NO puede ser eterno: el motor corre bajo pm2 sin reiniciarse, y
// antes esto significaba que un certificado nuevo puesto en la carpeta se ignoraba
// hasta el siguiente reinicio — las demandas salían con el del mes pasado, sin
// error ni aviso. Ahora caduca solo, y el sincronizador de insumos lo invalida en
// cuanto escribe un archivo (ver routes/plantillas.routes.js).
const COMPARTIDOS_TTL_MS = 10 * 60 * 1000;
let _compartidos = null;
let _compartidosAt = 0;

/** Fuerza que el próximo lote vuelva a mirar el disco. */
function invalidarCompartidos() {
  _compartidos = null;
}

function resolverCompartidos() {
  if (_compartidos && Date.now() - _compartidosAt < COMPARTIDOS_TTL_MS) return _compartidos;
  _compartidosAt = Date.now();
  const D = config.ANEXOS_DIR_DEMANDAS;
  const F = config.ANEXOS_DIR_FINANDINA;
  _compartidos = {
    ccoJRamos: archivoMasReciente(D, f => /J\s*RAMOS/i.test(f) && !/SIRNA/i.test(f)),
    sirna:     archivoMasReciente(D, f => /SIRNA/i.test(f)),
    superfin:  archivoMasReciente(F, f => /SUPER/i.test(f)),
    // ANEXO 7 — Cámara de Comercio de Banco Finandina. Se prefiere la versión
    // COMPRIMIDA (más liviana al unir) si existe; si no, cualquier "CCO FINANDINA"
    // (p.ej. "CCO FINANDINA JULIO 2026.pdf", que ya no lleva "COMPRIMIDA").
    ccoFin:    archivoMasReciente(F, f => /CCO\s*FINANDINA/i.test(f) && /COMPRIMID/i.test(f))
            || archivoMasReciente(F, f => /CCO\s*FINANDINA/i.test(f)),
    // Correo de otorgamiento del poder (ANEXO 1), respaldo si la web no lo envía.
    // Solo singulares ejecutivos; se excluyen los de pago directo.
    correoPoder: archivoMasRecienteRec(config.ANEXOS_DIR_PODERES,
                   f => /PODERES?\s+EJECUTIVOS?/i.test(f) && !/PAGO\s*DIRECTO/i.test(f)),
  };
  const r = _compartidos;
  console.error(`[ANEXOS] Certificados: JRamos=${r.ccoJRamos ? path.basename(r.ccoJRamos) : 'NO'} | SIRNA=${r.sirna ? path.basename(r.sirna) : 'NO'} | SuperFin=${r.superfin ? path.basename(r.superfin) : 'NO'} | CCOFinandina=${r.ccoFin ? path.basename(r.ccoFin) : 'NO'} | correoPoder=${r.correoPoder ? path.basename(r.correoPoder) : 'NO'}`);
  return _compartidos;
}

// ─── PDF helpers ──────────────────────────────────────────────────────────────

function wrap(texto, font, size, maxWidth) {
  const out = [];
  for (const parrafo of texto.split('\n')) {
    const words = parrafo.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth) cur = test;
      else { if (cur) out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out;
}

// Carátula "ANEXO N" + descripción centrada
function caratula(out, fontB, font, n, descripcion) {
  const W = 612, H = 792;
  const page = out.addPage([W, H]);
  const titulo = `ANEXO ${n}`;
  const tS = 18;
  const tw = fontB.widthOfTextAtSize(titulo, tS);
  page.drawText(titulo, { x: (W - tw) / 2, y: H - 170, size: tS, font: fontB });

  const dS = 13, maxW = 450;
  const lines = wrap(descripcion, font, dS, maxW);
  let y = H - 215;
  for (const ln of lines) {
    const lw = font.widthOfTextAtSize(ln, dS);
    page.drawText(ln, { x: (W - lw) / 2, y, size: dS, font });
    y -= dS * 1.6;
  }
}

async function anexarPdf(out, srcBytes, soloPaginas) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  let idx = soloPaginas || src.getPageIndices();
  idx = idx.filter(i => i >= 0 && i < src.getPageCount());
  const pgs = await out.copyPages(src, idx);
  pgs.forEach(p => out.addPage(p));
}

// ─── ANEXO 1 — Poder sobre el correo ───────────────────────────────────────────

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// Extrae el texto del poder .docx como una lista de párrafos (una entrada por
// <w:p>; las vacías marcan saltos de línea entre bloques).
function extraerParrafosDocx(docxBuffer) {
  const zip = new AdmZip(docxBuffer);
  const xml = zip.readAsText('word/document.xml');
  const parrafos = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    let inner = m[1].replace(/<w:tab\b[^>]*\/>/g, ' ').replace(/<w:br\b[^>]*\/>/g, ' ');
    let txt = '';
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) txt += t[1];
    parrafos.push(decodeXml(txt).replace(/\s+/g, ' ').trim());
  }
  // recortar párrafos vacíos al inicio/fin
  while (parrafos.length && !parrafos[0]) parrafos.shift();
  while (parrafos.length && !parrafos[parrafos.length - 1]) parrafos.pop();
  return parrafos;
}

// Sobrepone el texto del poder en el cuerpo en blanco del correo (página 1).
// El tamaño de fuente se reduce hasta que todo el poder quepa entre el
// encabezado del correo y el pie de página.
async function paginaPoderOverlay(out, correoBuffer, parrafos) {
  const correo = await PDFDocument.load(correoBuffer, { ignoreEncryption: true });
  const page   = correo.getPage(0);
  const { width, height } = page.getSize();
  const cFont  = await correo.embedFont(StandardFonts.Helvetica);

  const left = 75, maxW = width - 150;
  const startY = height - 180;   // debajo del encabezado del correo
  const bottom = 35;             // encima del pie (URL de Gmail)
  const available = startY - bottom;

  // Elegir el tamaño de fuente más grande (10..7) con el que todo quepa.
  let size = 10, leading = 12.5, lines = [];
  for (; size >= 7; size -= 0.5) {
    leading = size * 1.25;
    lines = [];
    for (const p of parrafos) {
      if (!p) { lines.push('§GAP§'); continue; }
      for (const ln of wrap(p, cFont, size, maxW)) lines.push(ln);
      lines.push('§GAP§');
    }
    let h = 0;
    for (const ln of lines) h += (ln === '§GAP§') ? leading * 0.55 : leading;
    if (h <= available) break;
  }

  let y = startY;
  for (const ln of lines) {
    if (ln === '§GAP§') { y -= leading * 0.55; continue; }
    if (y < bottom) break;
    page.drawText(ln, { x: left, y, size, font: cFont });
    y -= leading;
  }

  const [copied] = await out.copyPages(correo, [0]);
  out.addPage(copied);
}

// ─── Generación ───────────────────────────────────────────────────────────────

/**
 * Genera {carpeta}/ANEXOS.pdf del cliente. numeroPagare se usa en la carátula
 * del ANEXO 2. Devuelve la ruta del PDF o '' si no se pudo armar.
 */
async function generarAnexos(cedula, sacDocsDir, numeroPagare = '', correoPoderBuffer = null, opts = {}) {
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return '';

  const archivos = fs.readdirSync(dir);
  const pagare   = archivos.find(f => /\.pdf$/i.test(f) && !f.startsWith('SAC_')
                    && !/DATACREDITO/i.test(f) && /(PAGARE|DECEVAL)/i.test(f));
  const dirytel  = archivos.find(f => /^SAC_.*DIRYTEL\.pdf$/i.test(f));
  const datacred = archivos.find(f => /DATACREDITO\.pdf$/i.test(f));
  const poderDoc = archivos.find(f => /^PODER SINGULAR .*\.docx$/i.test(f) && !f.startsWith('~$'));
  // PDFs que, de existir, llenan los anexos condicionales (normalmente no están →
  // queda la carátula como placeholder para insertarlos a mano).
  // RUNT: puede haber uno por placa (SAC_{cedula}_RUNT_{placa}.pdf) → se anexan todos.
  const runtPdfs = archivos.filter(f => /\.pdf$/i.test(f) && /RUNT/i.test(f)).sort();
  const certEmpl = archivos.find(f => /\.pdf$/i.test(f) && /(C[AÁ]MARA|EXISTENCIA|CERT)/i.test(f)
                    && /(EMPLEAD|EMPRESA|PATRON)/i.test(f));
  const comp     = resolverCompartidos();

  // Condicionales: mismas reglas que la lista de pruebas de la demanda.
  const tieneVehiculos = Array.isArray(opts.vehiculos) && opts.vehiculos.length > 0;
  const empresaNom     = String(opts.empresa || '').trim();
  const empresaNit     = String(opts.nit || '').trim();
  const tieneEmpresa   = !!(empresaNom && empresaNit);
  const camara         = String(opts.camaraEmpleador || '').trim();
  // ¿Se incluye el DataCrédito? Solo si trae la tabla de correos (default true por
  // compatibilidad cuando el caller no lo informa).
  const incluirDatacredito = opts.datacreditoCorreos !== false;
  // Obligación(es) del préstamo que respalda el pagaré (para la carátula del ANEXO
  // del pagaré). Distinta del número de pagaré. Puede venir "X" o "X, Y".
  const obligacionesRespalda = String(opts.obligaciones || '').trim();

  try {
    const out   = await PDFDocument.create();
    const fontB = await out.embedFont(StandardFonts.HelveticaBold);
    const font  = await out.embedFont(StandardFonts.Helvetica);

    const leer = p => fs.readFileSync(p);

    // Numeración dinámica: cada anexo recibe el siguiente número consecutivo, de
    // modo que coincida con la lista de pruebas de la demanda (que añade/quita el
    // punto del RUNT y del empleador según los datos del demandado).
    let n = 0;
    const car = (desc) => caratula(out, fontB, font, ++n, desc);

    // ANEXO — Poder. La carátula va SIEMPRE (aunque no llegue el correo ni exista
    // el poder). El correo: primero el que sube la web (correoPoderBuffer) y, si
    // no llega, el más reciente del folder PODERES como respaldo. Si hay correo y
    // poder .docx → se sobrepone el poder; si hay correo sin poder → se anexa el
    // correo tal cual; si no hay correo → solo la carátula.
    let correoBytes = correoPoderBuffer;
    let correoOrigen = 'web';
    if (!correoBytes && comp.correoPoder) {
      try { correoBytes = leer(comp.correoPoder); correoOrigen = 'folder:' + path.basename(comp.correoPoder); }
      catch (e) { console.error(`[ANEXOS] ${cedula}: no se pudo leer el correo de respaldo: ${e.message}`); }
    }

    car(DESC.poder);
    try {
      if (correoBytes && poderDoc) {
        const parrafos = extraerParrafosDocx(leer(path.join(dir, poderDoc)));
        await paginaPoderOverlay(out, correoBytes, parrafos);
        console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (Poder) con poder sobrepuesto (correo=${correoOrigen})`);
      } else if (correoBytes) {
        await anexarPdf(out, correoBytes);
        console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (Poder) con correo pero sin poder .docx (correo=${correoOrigen})`);
      } else {
        console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (Poder) solo carátula (no hay correo del banco ni en web ni en folder)`);
      }
    } catch (e) {
      console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (Poder) — falló sobreponer el poder (${e.message}); queda la carátula`);
    }

    // ANEXO — Pagaré: "Pagare(s) No. {pagaré} Que respalda la(s) obligación(es) {obl}".
    let descPagare = DESC.pagare.replace('{OBLIGACION}', numeroPagare || '');
    if (obligacionesRespalda) {
      const plural = obligacionesRespalda.split(',').filter(s => s.trim()).length > 1;
      descPagare += plural
        ? ` Que respalda las obligaciones ${obligacionesRespalda}`
        : ` Que respalda la obligación ${obligacionesRespalda}`;
    }
    car(descPagare);
    if (pagare) await anexarPdf(out, leer(path.join(dir, pagare)));
    else console.error(`[ANEXOS] ${cedula}: sin PDF de pagaré (queda la carátula)`);

    // ANEXO — Pantallazo SAC (DIRYTEL) + DataCrédito COMPLETO (todas las páginas).
    // El DataCrédito SOLO se anexa y se menciona si trae la tabla de correos.
    car(incluirDatacredito ? DESC.sac : DESC.sacSinDc);
    if (dirytel)  await anexarPdf(out, leer(path.join(dir, dirytel)));
    if (incluirDatacredito && datacred) {
      await anexarPdf(out, leer(path.join(dir, datacred))); // todo el DataCrédito
    } else if (datacred && !incluirDatacredito) {
      console.error(`[ANEXOS] ${cedula}: DataCrédito sin tabla de correos → NO se anexa ni se menciona`);
    }

    // ANEXO — RUNT (consulta automotores): SOLO si el demandado tiene vehículos.
    // Se anexan TODOS los PDFs de consulta del RUNT guardados (uno por placa). Si
    // no hay ninguno (no se pudo entrar al RUNT), queda la carátula como placeholder.
    if (tieneVehiculos) {
      car(DESC.runt);
      if (runtPdfs.length) {
        for (const rp of runtPdfs) await anexarPdf(out, leer(path.join(dir, rp)));
        console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (RUNT) con ${runtPdfs.length} consulta(s): ${runtPdfs.join(', ')}`);
      } else {
        console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (RUNT) sin PDF → placeholder para añadir la consulta`);
      }
    }

    // ANEXO — Cámara de Comercio del EMPLEADOR: SOLO si hay empresa+NIT. Si no se
    // tiene el certificado (lo normal: RUES solo da la ciudad de la cámara, no el
    // PDF oficial), queda la carátula como placeholder para añadirlo.
    if (tieneEmpresa) {
      car(DESC.empleador
        .replace('{EMPRESA}', empresaNom || '#####')
        .replace('{CAMARA}', camara || '#####'));
      if (certEmpl) await anexarPdf(out, leer(path.join(dir, certEmpl)));
      else console.error(`[ANEXOS] ${cedula}: ANEXO ${n} (CCO empleador "${empresaNom}") sin PDF → placeholder (cámara: ${camara || '#####'})`);
    }

    // ANEXOS — certificados compartidos (más recientes). Carátula SIEMPRE.
    car(DESC.ccoJRamos); if (comp.ccoJRamos) await anexarPdf(out, leer(comp.ccoJRamos));
    car(DESC.sirna);     if (comp.sirna)     await anexarPdf(out, leer(comp.sirna));
    car(DESC.superfin);  if (comp.superfin)  await anexarPdf(out, leer(comp.superfin));
    car(DESC.ccoFin);    if (comp.ccoFin)    await anexarPdf(out, leer(comp.ccoFin));

    const outPath = path.join(dir, 'ANEXOS.pdf');
    fs.writeFileSync(outPath, await out.save());
    console.error(`[ANEXOS] ✓ ${cedula}: ${out.getPageCount()} página(s) → ANEXOS.pdf`);
    return outPath;
  } catch (e) {
    console.error(`[ANEXOS] ${cedula}: ${e.message}`);
    return '';
  }
}

module.exports = { generarAnexos, invalidarCompartidos };
