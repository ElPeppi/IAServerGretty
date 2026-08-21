/**
 * services/finandina/singular/carpetaCliente.js — Lectura de la carpeta de documentos del cliente
 *
 * Todo lo que se extrae de {SAC_OUT_DIR}/{cedula}/ :
 *   leerContactos      → CONTACTOS_{cedula}.csv (direcciones y emails)
 *   leerDatosDeSACPdfs → PDFs SAC_*.pdf (nombre, juzgado, fecha mora más antigua)
 *   leerDatosDeDeceval → PDF DECEVAL/PAGARÉ (número de pagaré, fecha suscripción)
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
const pdfParse = require('pdf-parse');

const { resolverCarpetaCedula } = require('../../../utils/carpetas');
const { MESES_MAP } = require('../../../utils/fechas');

// ─── Contactos CSV ────────────────────────────────────────────────────────────

// Parsea fechas tipo SAC: "08-06-2026 18:14", "08/06/2026" (DD-MM-YYYY [HH:mm])
function parseFechaUso(s) {
  const m = String(s || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)));
  return isNaN(d) ? null : d;
}

// Quita el contador de fila del DataCrédito que queda pegado al inicio del
// correo (p.ej. "1davi@x.com" → "davi@x.com"). Solo actúa si la lista viene
// enumerada en secuencia 1,2,3… (≥2), para no dañar correos que legítimamente
// empiezan por dígitos (p.ej. basados en cédula). Respaldo por si el CSV se
// generó antes del arreglo en sac_puppeteer.js.
function quitarContadorEnumeracion(emails) {
  const valido = (e, esp) => e.startsWith(esp) && /^[a-zA-Z0-9._%+-]+@/.test(e.slice(esp.length));
  let run = 0;
  while (run < emails.length && valido(emails[run], String(run + 1))) run++;
  if (run < 2) return emails.slice();
  let fila = 0;
  return emails.map(e => {
    const esp = String(fila + 1);
    if (valido(e, esp)) { fila++; return e.slice(esp.length); }
    return e;
  });
}

function leerContactos(cedula, sacDocsDir) {
  const result = {
    direccion: '', email: '', dirs: [], emails: [],
    // Dirección SAC con fecha de último uso más reciente
    direccionSacUltimoUso: '',
  };
  const p = path.join(resolverCarpetaCedula(sacDocsDir, cedula), `CONTACTOS_${cedula}.csv`);
  if (!fs.existsSync(p)) return result;

  try {
    const lines = fs.readFileSync(p, 'utf8')
      .replace(/^﻿/, '')   // BOM
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const dirsSac    = [];   // { valor, fechaUso: Date|null }
    const emailRows  = [];   // { valor, fuente }

    for (let i = 1; i < lines.length; i++) {
      // Formato: TIPO,"VALOR",FUENTE[,"ULTIMO_USO"]
      // (CSVs antiguos no traen la 4ª columna — sigue siendo válido)
      const m = lines[i].match(/^([^,]+),"([^"]*)",([^,"]*)(?:,"([^"]*)")?/);
      if (!m) continue;
      const tipo   = m[1].trim().toUpperCase();
      const valor  = m[2].trim();
      const fuente = (m[3] || '').trim().toUpperCase();
      const uso    = (m[4] || '').trim();
      if (!valor) continue;

      if (tipo === 'EMAIL') {
        emailRows.push({ valor, fuente });
      } else {
        result.dirs.push(valor);
        if (fuente === 'SAC') dirsSac.push({ valor, fechaUso: parseFechaUso(uso) });
      }
    }

    // Limpiar el contador de enumeración del DataCrédito pegado al correo (solo
    // en los del DataCrédito, que forman el bloque enumerado; los SAC intactos).
    const dcLimpios = quitarContadorEnumeracion(
      emailRows.filter(e => e.fuente === 'DATACREDITO').map(e => e.valor)
    );
    let di = 0;
    const emailsLimpios = emailRows.map(e => e.fuente === 'DATACREDITO' ? dcLimpios[di++] : e.valor);
    // Deduplicar (case-insensitive) preservando el orden: tras quitar el contador
    // un correo del DataCrédito puede coincidir con el de SAC.
    const vistoEmail = new Set();
    result.emails = emailsLimpios.filter(e => {
      const k = (e || '').toLowerCase();
      if (!k || vistoEmail.has(k)) return false;
      vistoEmail.add(k);
      return true;
    });

    result.direccion = result.dirs[0] || '';
    // Todos los correos separados por " - " para que aparezcan en la plantilla.
    result.email     = result.emails.join(' - ');

    // Dirección SAC con último uso más reciente; sin fechas → primera dirección SAC
    if (dirsSac.length > 0) {
      const conFecha = dirsSac.filter(d => d.fechaUso);
      conFecha.sort((a, b) => b.fechaUso - a.fechaUso);
      result.direccionSacUltimoUso = (conFecha[0] || dirsSac[0]).valor;
    }
  } catch (e) {
    console.error(`[CONTACTOS] ${cedula}: ${e.message}`);
  }
  return result;
}

// ─── Parseo de PDFs SAC descargados ──────────────────────────────────────────
// Lee los PDFs SAC_*.pdf en {sacDocsDir}/{cedula}/ y extrae todos los
// campos posibles: nombre, ciudad juzgado, capital, intereses, fechas, etc.

async function leerDatosDeSACPdfs(cedula, sacDocsDir) {
  const result = {
    nombre:           '',
    ciudadJuzgado:    '',
    tipoJuzgado:      '',
    capital:          0,
    interes:          0,
    total:            0,
    fechaMora:        '',   // fecha inicio mora MÁS ANTIGUA de todas las obligaciones
    fechaSuscripcion: '',
    nitEmpresa:       '',
    nombreEmpresa:    '',
  };

  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return result;

  const pdfs = fs.readdirSync(dir).filter(f =>
    f.startsWith('SAC_') && f.toLowerCase().endsWith('.pdf')
  );

  if (pdfs.length === 0) return result;

  // Acumulamos todas las fechas de mora para quedarnos con la más antigua
  const fechasMora = [];

  for (const pdfName of pdfs) {
    try {
      const buffer = fs.readFileSync(path.join(dir, pdfName));
      const parsed = await pdfParse(buffer, { max: 0 });
      // SAC PDFs a veces concatenan campo+valor sin separador ("FechaInicioMora14-03-2026")
      // Usamos el texto crudo (sin colapsar espacios) para preservar los saltos
      const texto  = (parsed.text || '').replace(/[ \t]{2,}/g, ' ');

      // ── Nombre del deudor ────────────────────────────────────────────────
      if (!result.nombre) {
        const patterns = [
          /(?:NOMBRE\s+(?:DEL?\s+)?(?:DEUDOR|CLIENTE|TITULAR))\s*[:\-]?\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n|[0-9]|CÉDULA|NIT|OBLIGACI)/i,
          /(?:DEUDOR|CLIENTE|TITULAR)\s*[:\-]\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n)/i,
          /(?:NOMBRES?\s+Y\s+APELLIDOS?)\s*[:\-]?\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{5,70}?)(?=\s{2,}|\n)/i,
        ];
        for (const re of patterns) {
          const m = texto.match(re);
          if (m && m[1].trim().split(/\s+/).length >= 2) {
            result.nombre = m[1].trim();
            break;
          }
        }
      }

      // ── Ciudad del juzgado ───────────────────────────────────────────────
      if (!result.ciudadJuzgado) {
        const juzgadoM = texto.match(/JUZGADO\s+(CIVIL\s+(?:MUNICIPAL|DEL?\s+CIRCUITO|PROMISCUO\s+MUNICIPAL))\s+(?:DE\s+)?([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]{2,30}?)(?=\s{2,}|\n|[0-9])/i);
        if (juzgadoM) {
          result.tipoJuzgado   = `JUZGADO ${juzgadoM[1].trim().toUpperCase()}`;
          result.ciudadJuzgado = juzgadoM[2].trim().toUpperCase();
        }
      }

      // ── Fecha Inicio Mora ────────────────────────────────────────────────
      // Formato SAC: "Fecha Inicio Mora23-01-2026" (sin espacio entre campo y valor)
      // Colectar todas; al final tomamos la más antigua.
      const moraM = texto.match(/Fecha\s+Inicio\s+Mora\s*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
      if (moraM) {
        const raw = moraM[1]; // "23-01-2026" → DD-MM-YYYY
        const parts = raw.split(/[\/\-]/);
        if (parts.length === 3) {
          const d = new Date(Date.UTC(+parts[2], +parts[1] - 1, +parts[0]));
          if (!isNaN(d)) fechasMora.push({ d, raw });
        }
      }

      // ── Empleador ────────────────────────────────────────────────────────
      if (!result.nombreEmpresa) {
        const empM = texto.match(/(?:EMPRESA|EMPLEADOR|VINCULO\s+LABORAL)\s*[:\-]\s*([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 .,&-]{4,70}?)(?=\s{2,}|\n)/i);
        if (empM) result.nombreEmpresa = empM[1].trim();
      }
      if (!result.nitEmpresa) {
        const nitM = texto.match(/(?:NIT|CC\/NIT)\s+(?:EMPRESA|EMPLEADOR)\s*[:\-]?\s*([\d.,-]+)/i);
        if (nitM) result.nitEmpresa = nitM[1].trim();
      }

    } catch (e) {
      console.error(`[PDF-SAC] ${cedula}/${pdfName}: ${e.message}`);
    }
  }

  // Fecha mora más antigua (la que lleva más tiempo en mora)
  if (fechasMora.length > 0) {
    fechasMora.sort((a, b) => a.d - b.d);
    result.fechaMora = fechasMora[0].raw.replace(/-/g, '/'); // DD/MM/YYYY
    console.error(`[PDF-SAC] ${cedula}: ${fechasMora.length} fecha(s) mora → más antigua: ${result.fechaMora}`);
  }

  if (result.nombre) {
    console.error(`[PDF-SAC] ${cedula}: nombre="${result.nombre}" ciudad="${result.ciudadJuzgado}"`);
  }
  return result;
}

// ─── Parseo de PDFs DECEVAL / PAGARÉ ─────────────────────────────────────────
// Lee el PDF del pagaré DECEVAL (o PAGARE) para extraer:
//   - numeroPagare       → "pagaré No. XXXXXXXX"
//   - fechaSuscripcion   → fecha en que el cliente firmó el pagaré
//   - fechaCertificacion → fecha de expedición del certificado DECEVAL
//   - certificadoValido  → true solo si el PDF es un CERTIFICADO DE DEPÓSITO EN
//                          ADMINISTRACIÓN de Deceval con texto extraíble.
//                          Quedan por fuera: fotos/escaneados (sin texto) y
//                          formatos de pagaré en blanco (sin marcadores Deceval).

function parseFechaSuscripcion(texto) {
  // 1) Formato ISO: "se firma el día 2021-10-06"
  let m = texto.match(/se\s+firma\s+el\s+d[ií]a\s+(\d{4})[\/\-](\d{2})[\/\-](\d{2})/i);
  if (m) {
    return `${m[3]}/${m[2]}/${m[1]}`; // DD/MM/YYYY
  }
  // 2) Formato electrónico: "Fecha: 06/10/2021" o "Fecha: 06-10-2021"
  m = texto.match(/\bFecha[:\s]+(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i);
  if (m) {
    return `${m[1]}/${m[2]}/${m[3]}`; // DD/MM/YYYY (ya viene en ese orden)
  }
  // 3) Texto colombiano: "el día 24 del mes de enero del año 2024"
  //    o "a los (24) días del mes de enero del año 2024"
  m = texto.match(/(?:el\s+d[ií]a\s+(\d+)|a\s+los\s+\((\d+)\)\s+d[ií]as?)\s+del\s+mes\s+de\s+(\w+)\s+del\s+a[ñn]o\s+(\d{4})/i);
  if (m) {
    const dd  = String(m[1] || m[2]).padStart(2, '0');
    const mes = MESES_MAP[(m[3] || '').toLowerCase()];
    const yy  = m[4];
    if (mes) return `${dd}/${String(mes).padStart(2, '0')}/${yy}`;
  }
  return '';
}

// Marcadores que identifican el certificado DECEVAL real
const RE_CERT_DECEVAL = /CERTIFICADO DE DEP[OÓ]SITO EN ADMINISTRACI[OÓ]N/i;
const RE_DECEVAL      = /DECEVAL/i;

async function leerDatosDeDeceval(cedula, sacDocsDir) {
  const result = {
    numeroPagare: '', fechaSuscripcion: '', direccion: '',
    fechaCertificacion: '', certificadoValido: false, tienePdf: false,
    // tipoPagare: 'DECEVAL' (con texto) | 'FINANDINA' (escaneado) | '' (sin pagaré usable)
    tipoPagare: '', nombre: '',
    // true si `numeroPagare` lo leyó el OCR de una imagen (no de una capa de
    // texto): es fiable pero no infalible, así que la demanda lo avisa.
    numeroPagareOcr: false,
    // ¿El pagaré está diligenciado? Los certificados DECEVAL siempre lo están;
    // para los escaneados (FINANDINA) lo decide el OCR (un formato en blanco → false).
    diligenciado: true,
  };
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return result;

  let escaneadoPath  = ''; // pagaré sin texto (imagen) → candidato a OCR (tipo FINANDINA)
  let certificadoPath = ''; // PDF que se detectó como certificado DECEVAL

  // PDFs de pagaré: DECEVAL.pdf, PAGARE.pdf, PAGARE 001.pdf, etc.
  // Excluir: DATACREDITO.pdf, FOR EJE.pdf, FOR INI.pdf, PRENDA.pdf, TESTIGO.pdf, SAC_*.pdf
  const EXCLUIR_RE = /(?:DATACREDITO|FOR\s+(?:EJE|INI)|PRENDA|TESTIGO)/i;
  const pdfs = fs.readdirSync(dir).filter(f => {
    const up = f.toUpperCase();
    return f.toLowerCase().endsWith('.pdf')
      && !f.startsWith('SAC_')
      && !EXCLUIR_RE.test(f)
      && (up.includes('DECEVAL') || up.includes('PAGARE'));
  });

  result.tienePdf = pdfs.length > 0;

  for (const pdfName of pdfs) {
    try {
      const buffer = fs.readFileSync(path.join(dir, pdfName));
      const parsed = await pdfParse(buffer, { max: 0 });
      const texto  = parsed.text || '';

      // ── Validación: ¿es un certificado DECEVAL real? ──────────────────
      // Fotos/escaneados producen texto casi vacío; los formatos de pagaré
      // en blanco tienen texto pero sin los marcadores del certificado.
      const esCertificado = texto.length > 500
        && RE_CERT_DECEVAL.test(texto)
        && RE_DECEVAL.test(texto);
      if (esCertificado && !result.certificadoValido) {
        result.certificadoValido = true;
        certificadoPath = path.join(dir, pdfName);
        console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: certificado DECEVAL válido ✓`);
      }

      // Candidato a OCR (FINANDINA): cualquier pagaré que NO sea certificado DECEVAL.
      // Incluye tanto la imagen pura (sin texto) como el PDF digital de Banco Finandina,
      // cuya capa de texto trae SOLO los campos diligenciados (nº, nombre, ciudad, fechas,
      // montos) y por tanto supera el viejo umbral de "<80 chars". El OCR decide después
      // si está diligenciado o es un formato en blanco.
      if (!esCertificado && !escaneadoPath) {
        escaneadoPath = path.join(dir, pdfName);
      }

      // ── Fecha de expedición del certificado ──────────────────────────
      // Encabezado: "Ciudad, Fecha y Hora de Expedición ... 04/06/2026 16:46:01"
      // (el título del certificado queda entre la etiqueta y el valor al extraer)
      if (esCertificado && !result.fechaCertificacion) {
        const certM = texto.match(/Expedici[oó]n[\s\S]{0,250}?(\d{2}\/\d{2}\/\d{4})\s*\d{2}:\d{2}/i)
                   || texto.match(/Expedici[oó]n[\s\S]{0,250}?(\d{2}\/\d{2}\/\d{4})/i);
        if (certM) {
          result.fechaCertificacion = certM[1];
          console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: certificación=${result.fechaCertificacion}`);
        }
      }

      // ── Número de pagaré ──────────────────────────────────────────────
      if (!result.numeroPagare) {
        // Buscar "pagaré No. 14077915" (dígitos reales, no guiones/blancos)
        const pagM = texto.match(/pagar[eé]\s+No\.?\s*(\d{4,})/i);
        if (pagM) {
          result.numeroPagare = pagM[1].trim();
          console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: pagaré #${result.numeroPagare}`);
        }
      }

      // ── Fecha de suscripción (cuando firmó el cliente) ────────────────
      if (!result.fechaSuscripcion) {
        const fecha = parseFechaSuscripcion(texto);
        if (fecha) {
          result.fechaSuscripcion = fecha;
          console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: suscripción=${fecha}`);
        }
      }

      // ── Dirección del otorgante ───────────────────────────────────────
      // Bloque de firma del pagaré:
      //   "OTORGANTE ... Nombre:... C.C:... Dirección:CL 15 13 A 52 \n Telefono:"
      if (!result.direccion) {
        const dirM = texto.match(/OTORGANTE[\s\S]{0,400}?Direcci[oó]n\s*:\s*([^\n]+)/i)
                  || texto.match(/Direcci[oó]n\s*:\s*([^\n]+)/i);
        if (dirM) {
          const direccion = dirM[1].trim();
          if (direccion.length >= 4 && !/^[\s\-–—.]*$/.test(direccion)) {
            result.direccion = direccion;
            console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: dirección="${direccion}"`);
          }
        }
      }

    } catch (e) {
      console.error(`[PDF-DECEVAL] ${cedula}/${pdfName}: ${e.message}`);
    }
  }

  // ── Validación DECEVAL: debe traer el número de pagaré ───────────────────────
  // Un certificado DECEVAL real SIEMPRE indica el "pagaré No. XXXXXXXX". Si lo
  // detectamos como DECEVAL pero NO hay número, la detección no es confiable
  // (texto que solo parece certificado). En ese caso se trata como pagaré
  // ESCANEADO (FINANDINA): se OCR-ea el mismo PDF (o el escaneado si hay otro) y
  // el número vendrá de la OBLIGACION del Excel. Evita demandas DECEVAL sin nº.
  if (result.certificadoValido && !result.numeroPagare) {
    console.error(`[PDF-DECEVAL] ${cedula}: clasificado DECEVAL pero SIN número de pagaré → se reintenta como escaneado (FINANDINA)`);
    result.certificadoValido = false;
    if (!escaneadoPath) escaneadoPath = certificadoPath;
  }

  // ── Tipo de pagaré ──────────────────────────────────────────────────────────
  if (result.certificadoValido) {
    result.tipoPagare = 'DECEVAL';
  } else if (escaneadoPath) {
    // Pagaré escaneado (solo BANCO FINANDINA): se extraen por OCR los MISMOS datos
    // que del DECEVAL, INCLUIDO el número impreso en la línea "PAGARÉ No.".
    //
    // Ese número es el del TÍTULO VALOR, que es lo que debe citar la demanda; la
    // OBLIGACION del Excel identifica la deuda que el pagaré respalda, no el
    // pagaré. Antes se descartaba y la demanda citaba la obligación como si fuera
    // el pagaré. Se marca `numeroPagareOcr` para que quien revise sepa que salió
    // de una lectura de imagen y pueda corregirlo a mano.
    result.tipoPagare = 'FINANDINA';
    try {
      const { ocrPdf, extraerCamposPagare } = require('../../ocr');
      const r = await ocrPdf(fs.readFileSync(escaneadoPath), { scale: 3, maxPages: 2 });
      const c = extraerCamposPagare(r.text);
      if (!result.direccion && c.direccion)            result.direccion = c.direccion;
      if (!result.fechaSuscripcion && c.fechaCorta)    result.fechaSuscripcion = c.fechaCorta;
      if (c.nombre)                                    result.nombre = c.nombre;
      if (c.numeroPagare) { result.numeroPagare = c.numeroPagare; result.numeroPagareOcr = true; }

      // Señal ADICIONAL de "diligenciado" desde la CAPA DE TEXTO del PDF.
      // Muchos pagarés Finandina son híbridos: imagen escaneada (acuse de recibo,
      // tarjeta, etc.) + una capa de texto delgada con los campos LLENOS (ciudad,
      // fecha, capital, intereses). El OCR a veces lee la página equivocada y no ve
      // el cuerpo del pagaré (caso YEYSON: el OCR leyó el acuse de la tarjeta), pero
      // la capa de texto sí trae los montos. Si hay ≥1 monto en pesos con formato
      // colombiano (p.ej. 5.210.410 → ≥ $100.000), el cuerpo está diligenciado.
      let cuerpoLlenoPorTexto = false;
      try {
        const textoLayer = (await pdfParse(fs.readFileSync(escaneadoPath), { max: 0 })).text || '';
        cuerpoLlenoPorTexto = (textoLayer.match(/\b\d{1,3}(?:\.\d{3})+\b/g) || [])
          .some((s) => parseInt(s.replace(/\./g, ''), 10) >= 100000);
      } catch { /* sin capa de texto → solo cuenta el OCR */ }

      // Pagaré escaneado en blanco (sin diligenciar) → no se puede demandar.
      result.diligenciado = !!c.diligenciado || cuerpoLlenoPorTexto;
      console.error(`[PDF-FINANDINA] ${cedula}: pagaré escaneado → OCR (diligenciado=${result.diligenciado}, señal=${c.diligenciado ? 'OCR' : cuerpoLlenoPorTexto ? 'capa-texto' : 'ninguna'}, nombre="${c.nombre}", dir="${c.direccion}", fecha=${c.fechaCorta || '-'})`);
    } catch (e) {
      console.error(`[PDF-FINANDINA] ${cedula}: OCR falló: ${e.message}`);
    }
  }

  return result;
}

/**
 * Correos electrónicos que trae el PDF de DataCrédito del cliente.
 *
 * Hacen falta porque el CSV de contactos solo tiene los que capturó el scraping
 * del SAC; cuando el DataCrédito se sube a mano (o el SAC no los listó), sus
 * correos se quedaban fuera de la demanda aunque estuvieran en el anexo. Se
 * devuelven en el ORDEN del documento, sin repetidos.
 */
async function leerCorreosDeDatacredito(cedula, sacDocsDir) {
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return [];
  const dc = fs.readdirSync(dir).find(f => /DATACREDITO\.pdf$/i.test(f));
  if (!dc) return [];
  try {
    const t = (await pdfParse(fs.readFileSync(path.join(dir, dc)), { max: 0 })).text || '';

    // Solo la TABLA de correos del deudor, no todo el PDF: el informe trae más
    // adelante otras secciones (direcciones, entidades…) y no deben colarse
    // correos que no son del demandado.
    //   "Correo ElectrónicoReportado Por…Fuente"
    //   "1leoescudero@…-OCT - 2025JUN - 20261SUS"
    //   …
    //   "#DirecciónEstrato…"        ← aquí termina
    const ini = t.search(/Correo\s+Electr[oó]nico/i);
    if (ini < 0) return [];
    const resto = t.slice(ini);
    const fin = resto.search(/\n\s*#\s*(Direcci[oó]n|Tel[eé]fono|Entidad)/i);
    const bloque = fin > 0 ? resto.slice(0, fin) : resto;

    const vistos = new Set();
    const out = [];
    for (const m of bloque.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      // Las filas vienen numeradas ("1leoescudero@…"): se quita el contador pegado.
      const correo = m[0].replace(/^\d{1,2}(?=[a-zA-Z])/, '').toLowerCase();
      if (vistos.has(correo)) continue;
      vistos.add(correo);
      out.push(correo);
    }
    return out;
  } catch (e) {
    console.error(`[DATACREDITO] ${cedula}: no se pudieron leer los correos: ${e.message}`);
    return [];
  }
}

// ¿El PDF de DataCrédito del cliente trae la tabla de correos electrónicos?
// (encabezado "Correo Electrónico"). Si no, no aporta direcciones electrónicas
// → no se anexa ni se menciona en la demanda.
async function datacreditoTieneCorreos(cedula, sacDocsDir) {
  const dir = resolverCarpetaCedula(sacDocsDir, cedula);
  if (!fs.existsSync(dir)) return false;
  const dc = fs.readdirSync(dir).find(f => /DATACREDITO\.pdf$/i.test(f));
  if (!dc) return false;
  try {
    const t = (await pdfParse(fs.readFileSync(path.join(dir, dc)), { max: 0 })).text || '';
    return /Correo\s+Electr[oó]nico/i.test(t);
  } catch (e) {
    console.error(`[DATACREDITO] ${cedula}: no se pudo leer para detectar correos: ${e.message}`);
    return false;
  }
}

module.exports = {
  leerContactos,
  leerDatosDeSACPdfs,
  leerDatosDeDeceval,
  datacreditoTieneCorreos,
  leerCorreosDeDatacredito,
};
