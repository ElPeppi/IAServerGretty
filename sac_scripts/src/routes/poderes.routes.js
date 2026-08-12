/**
 * routes/poderes.routes.js — Generación del Word COMBINADO de poderes por asignación
 *
 *   POST /generar-poderes → recibe las filas de la asignación y arma UN solo Word
 *     con todos los poderes (uno por cliente, salto de página), como el consolidado
 *     que la oficina hace a mano. Lo guarda en la carpeta PODERES y lo devuelve en
 *     base64 para que el backend lo referencie/sirva.
 *
 *   Los datos del poder (NOMBRE, CIUDAD/TIPO DE JUZGADO, CUANTIA, OBLIGACIONES) se
 *   calculan con el MISMO pipeline de la demanda (parsearExcelEntrada + construirFilas),
 *   no leyendo las columnas crudas del Excel. Así el poder queda idéntico al que la
 *   demanda genera por cliente (nombre mapeado, todas las obligaciones).
 *
 *   TIPO/CIUDAD DE JUZGADO: se consulta la RAMA JUDICIAL (Puppeteer) por ciudad para
 *   saber si hay PEQUEÑAS CAUSAS o PROMISCUO (cuantía mínima/menor). Regla: pequeñas
 *   causas → si no, civil municipal → si no, promiscuo. Barranquilla con pequeñas
 *   causas lleva la LOCALIDAD del demandado. Si Puppeteer no está disponible, cae a
 *   CIVIL MUNICIPAL (mismo comportamiento que la demanda sin navegador).
 *
 *   Nº de pagaré del poder («OBLIGACION» de la plantilla):
 *     - docsEnServidor = true  → se lee del certificado DECEVAL del cliente. Solo se
 *       EXCLUYE si el cliente no tiene documentos en el servidor (no se compara la
 *       fecha de los documentos contra la de asignación).
 *     - docsEnServidor = false → se usa la OBLIGACION del Excel para todos.
 */

'use strict';

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const puppeteer = require('puppeteer');

const config = require('../config');
const { generarPoderesCombinado, camposPagoDirecto, sinPostProceso } = require('../services/singular/poderes');
const { parsearExcelEntrada }     = require('../services/singular/excelEntrada');
const { construirFilas }          = require('../services/singular/plantillaXlsx');
const { calcularCuantia, tipoCuantia, tipoJuzgadoPagoDirecto, normalizarTipoJuzgado } = require('../domain/cuantia');
const { parseAnyDate, todayString }    = require('../utils/fechas');
const { leerDatosDeDeceval } = require('../services/singular/carpetaCliente');
const { loadRamaCache, buscarCorreoJuzgado, necesitaConsultaRama } = require('../services/singular/ramaJudicial');
const { determinarLocalidad } = require('../services/singular/localidadBarranquilla');
const { resolverCarpetaLectura, mkdirpSync } = require('../utils/carpetas');

const router = express.Router();

// "DD/MM/YYYY" o ISO → Date (o null).
function parseFechaAsig(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// ¿El cliente tiene PDFs en su carpeta? Devuelve también la ruta revisada (para el
// motivo de exclusión, así se ve exactamente dónde se buscó).
function docsDelCliente(outBase, cedula) {
  const dir = resolverCarpetaLectura(outBase, cedula);
  if (!fs.existsSync(dir)) return { existe: false, dir };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f)); } catch { /* noop */ }
  return { existe: files.length > 0, dir };
}

// ─── POST /generar-poderes ────────────────────────────────────────────────────
// Body: { excelBase64, tipo?, docsEnServidor?, fechaAsignacion?, nombre?, soloCedulas?, smmv?, outputBaseDir? }
// excelBase64 = Excel ORIGINAL de la asignación (Hoja1 + Hoja2). Se requiere Hoja2:
// de ahí salen capital/interés (→ cuantía → tipo de juzgado) y TODAS las obligaciones.
//
// tipo: 'singular' (por defecto) → PODER EJECUTIVO SINGULAR.
//       'pago_directo'           → PODER DE TRÁMITE DE PAGO DIRECTO (garantía
//                                  mobiliaria, Ley 1676/2013): aprehensión y
//                                  entrega del vehículo. Otra plantilla, otros
//                                  marcadores, y NO usa cuantía ni pagaré.
router.post('/generar-poderes', async (req, res) => {
  let excelBuffer = null;
  if (req.body.excelBase64) {
    try { excelBuffer = Buffer.from(String(req.body.excelBase64), 'base64'); } catch { /* noop */ }
  }
  if (!excelBuffer || !excelBuffer.length) {
    return res.status(400).json({ success: false, error: 'No se recibió el Excel de la asignación (excelBase64).' });
  }

  const docsEnServidor = !!req.body.docsEnServidor;
  const fechaAsig      = parseFechaAsig(req.body.fechaAsignacion); // solo para la carpeta PODERES/{año}
  const fechaAsigTexto = parseAnyDate(req.body.fechaAsignacion) || todayString();
  const outBase        = req.body.outputBaseDir || config.OUT_DIR;
  const smmv           = req.body.smmv || undefined;
  const soloSet        = Array.isArray(req.body.soloCedulas) && req.body.soloCedulas.length
    ? new Set(req.body.soloCedulas.map(c => String(c).replace(/\D/g, '')))
    : null;
  const nombreLote     = String(req.body.nombre || 'ASIGNACION').replace(/[<>:"/\\|?*]/g, ' ').trim();
  // Tipo de poder. Cualquier valor desconocido cae a 'singular' (comportamiento previo).
  const esPagoDirecto  = String(req.body.tipo || '').toLowerCase() === 'pago_directo';

  console.log(`[${new Date().toISOString()}] /generar-poderes: Excel ${excelBuffer.length} bytes, tipo=${esPagoDirecto ? 'pago_directo' : 'singular'}, docsEnServidor=${docsEnServidor}`);

  // ── Enriquecer con el pipeline de la demanda (mapeo de columnas + financieros) ──
  // parsearExcelEntrada mapea NOMBRE_CLIENTE→NOMBRE, agrega OBLIGACIONES por cédula
  // (Hoja2), deduplica y excluye procesos que NO son ejecutivo singular.
  let clientesEnriquecidos;
  try {
    clientesEnriquecidos = await parsearExcelEntrada(excelBuffer, {
      proceso: esPagoDirecto ? 'pago_directo' : 'singular',
    });
  } catch (e) {
    console.error(`[/generar-poderes] error parseando Excel: ${e.message}`);
    return res.status(500).json({ success: false, error: `Error leyendo la asignación: ${e.message}` });
  }
  const omitidosProceso = Array.isArray(clientesEnriquecidos.omitidosProceso) ? clientesEnriquecidos.omitidosProceso : [];

  const items     = [];   // → generarPoderesCombinado ({ fila: main })
  const metaPorCedula = new Map();
  const excluidos = [...omitidosProceso];

  // Rama Judicial para el tipo/ciudad de juzgado por ciudad. Mismo cache (30 días)
  // que la demanda. Solo se lanza Puppeteer si ALGUNA ciudad no está en cache fresca
  // ni en config manual — si la Rama ya está cacheada, corre sin navegador.
  const cacheFile = path.join(outBase, 'rama_judicial_cache.json');
  loadRamaCache(cacheFile);

  let necesitaBrowser = false;
  for (const c of clientesEnriquecidos) {
    const ced = String(c.cedula || '').trim();
    if (!ced || (soloSet && !soloSet.has(ced))) continue;
    const f = c.financieros || {};
    const cuantiaLbl = tipoCuantia(f.total || calcularCuantia(f.capital, f.interes), smmv);
    if (necesitaConsultaRama(c.ciudad, cuantiaLbl)) { necesitaBrowser = true; break; }
  }

  let browser = null;
  if (necesitaBrowser) {
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
      });
    } catch (e) {
      console.error(`[/generar-poderes] Puppeteer no disponible: ${e.message}. Juzgado por cuantía (CIVIL MUNICIPAL).`);
    }
  } else {
    console.log('[/generar-poderes] Rama Judicial en cache fresca — sin Puppeteer.');
  }

  try {
    for (const cliente of clientesEnriquecidos) {
      const cedula = String(cliente.cedula || '').trim();
      if (!cedula) continue;
      if (soloSet && !soloSet.has(cedula)) continue;  // subconjunto seleccionado en la web

      const nombre = String(cliente.nombre || '').trim();
      const f = cliente.financieros || {};
      const total = f.total || calcularCuantia(f.capital, f.interes);
      // El pago directo no tiene cuantía (no es un ejecutivo). Se pide 'MINIMA'
      // solo para que la consulta a la Rama resuelva el nivel MUNICIPAL, que es
      // de donde sale hasPromiscuo.
      const cuantiaLbl = esPagoDirecto ? 'MINIMA' : tipoCuantia(total, smmv);

      let numeroPagare = String(f.obligacion || '').trim(); // por defecto: OBLIGACION del Excel
      let pagareDesdeDocs = false;

      // El poder de pago directo no menciona el pagaré → no se leen los documentos.
      if (docsEnServidor && !esPagoDirecto) {
        const info = docsDelCliente(outBase, cedula);
        if (!info.existe) {
          excluidos.push({ cedula, nombre, motivo: `sin documentos en el servidor (${info.dir})` });
          continue;
        }
        try {
          const deceval = await leerDatosDeDeceval(cedula, outBase);
          if (deceval.certificadoValido && deceval.numeroPagare) {
            numeroPagare = String(deceval.numeroPagare).trim();
            pagareDesdeDocs = true;
          }
        } catch (e) {
          console.error(`[/generar-poderes] ${cedula}: no se pudo leer DECEVAL: ${e.message}`);
        }
      }

      // ── Tipo/ciudad de juzgado (Rama Judicial), igual que la demanda ──────────
      // Se llama aunque browser sea null: usa la cache (30 días). Solo consulta en
      // vivo si hay navegador y la ciudad no estaba cacheada.
      const ciudad = String(cliente.ciudad || '').trim();
      let courtInfo = { hasSmallClaims: false, hasPromiscuo: false };
      if (ciudad) {
        try {
          const rama = await buscarCorreoJuzgado(browser, ciudad, cuantiaLbl, cacheFile);
          courtInfo = { hasSmallClaims: rama.hasSmallClaims, hasPromiscuo: rama.hasPromiscuo };
        } catch (e) {
          console.error(`[/generar-poderes] ${cedula} (${ciudad}): Rama Judicial falló: ${e.message}`);
        }
      }
      // Barranquilla con pequeñas causas → la ciudad del juzgado lleva la LOCALIDAD.
      // No aplica al pago directo: ese nunca va a Pequeñas Causas (ver más abajo).
      let ciudadJuzgado = ciudad;
      if (!esPagoDirecto && /^BARRANQUILLA\b/i.test(ciudad) && courtInfo.hasSmallClaims) {
        let loc = '';
        try { loc = await determinarLocalidad(cliente.direccion); } catch { /* noop */ }
        ciudadJuzgado = loc ? `BARRANQUILLA LOCALIDAD ${loc}` : 'BARRANQUILLA LOCALIDAD #######';
      }

      // ── PAGO DIRECTO: item propio, sin la fila canónica de la demanda ────────
      // El juzgado NO sale de la cuantía: civil municipal, o promiscuo donde no
      // hay civil (lo dice la Rama). El bien se identifica con marca/modelo/placa.
      if (esPagoDirecto) {
        const tipoJ = normalizarTipoJuzgado(tipoJuzgadoPagoDirecto(courtInfo.hasPromiscuo));
        const placa = (cliente.placas && cliente.placas[0]) || '';
        if (!placa) {
          excluidos.push({ cedula, nombre, motivo: 'sin placa del vehículo dado en garantía' });
          continue;
        }
        items.push({
          cedula, nombre,
          tipoJuzgado: tipoJ,
          ciudadJuzgado,
          placa,
          marca:  cliente.garantia,        // "CHEVROLET ONIX" (marca + línea)
          modelo: cliente.modeloVehiculo,  // año del vehículo
        });
        metaPorCedula.set(cedula, { nombre, ciudadJuzgado, tipoJuzgado: tipoJ, placa });
        continue;
      }

      // Fila canónica (misma que la demanda): TIPO/CIUDAD DE JUZGADO, NOMBRE, CUANTIA,
      // OBLIGACION (nº pagaré) y OBLIGACIONES (todas).
      const clienteJuzgado = { ...cliente, ciudad: ciudadJuzgado };
      const { main } = construirFilas(
        clienteJuzgado, [{}], {}, '', fechaAsigTexto, cuantiaLbl, numeroPagare, courtInfo, ''
      );

      items.push({ fila: main, pagare: numeroPagare });
      metaPorCedula.set(cedula, {
        nombre,
        ciudadJuzgado: String(main['CIUDAD DE JUZGADO'] || '').trim(),
        tipoJuzgado:   String(main['TIPO DE JUZGADO']   || '').trim(),
        numeroPagare,
        pagareDesdeDocs,
      });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!items.length) {
    return res.status(422).json({
      success: false,
      error: 'Ningún cliente quedó válido para generar poderes.',
      excluidos,
    });
  }

  let buffer, clientesGen;
  try {
    const plantilla = esPagoDirecto ? config.PLANTILLA_PODER_PAGO_DIRECTO : config.PLANTILLA_PODER;
    const opts = esPagoDirecto
      ? { construirCampos: camposPagoDirecto, postProcesar: sinPostProceso }
      : {};
    ({ buffer, clientes: clientesGen } = generarPoderesCombinado(items, plantilla, opts));
  } catch (e) {
    console.error(`[/generar-poderes] error armando el Word: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }

  // Guardar el Word combinado en la carpeta PODERES/{año} del disco. Cada proceso
  // tiene la suya: la del pago directo aparte, porque ANEXOS_DIR_PODERES es además
  // de donde se toma el correo de otorgamiento (ANEXO 1) del ejecutivo singular.
  // El que cuenta es el que sube el backend a Drive; éste es la copia local.
  const anio   = fechaAsig ? fechaAsig.getFullYear() : new Date().getFullYear();
  const baseDir  = esPagoDirecto ? config.ANEXOS_DIR_PODERES_PAGO_DIRECTO : config.ANEXOS_DIR_PODERES;
  const poderDir = path.join(baseDir, String(anio));
  // Nombres como los históricos de la oficina en cada carpeta.
  const filename = `${esPagoDirecto ? 'PODER PAGO DIRECTO' : 'PODERES EJECUTIVOS'} ${nombreLote}.docx`;
  let savedPath = null;
  try {
    mkdirpSync(poderDir);
    savedPath = path.join(poderDir, filename);
    fs.writeFileSync(savedPath, buffer);
    console.log(`[/generar-poderes] Word guardado: ${savedPath}`);
  } catch (e) {
    console.error(`[/generar-poderes] no se pudo guardar en PODERES: ${e.message}`);
  }

  // Enriquecer los clientes generados con la metadata (ciudad/juzgado, origen del pagaré).
  const clientes = clientesGen.map(c => ({ ...c, ...(metaPorCedula.get(c.cedula) || {}) }));

  const ok = clientes.length;
  console.log(`[/generar-poderes] completado: ${ok} poder(es), ${excluidos.length} excluido(s)`);
  return res.json({
    success: true,
    poderFilename: filename,
    poderPath: savedPath,
    poderBase64: buffer.toString('base64'),
    docsEnServidor,
    clientes,
    excluidos,
  });
});

module.exports = router;
