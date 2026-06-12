/**
 * services/singular — Procesador de Plantilla Singular (orquestador)
 *
 * Flujo completo:
 *   1. Parsear Excel de entrada (filtra clientes DECEVAL)        → excelEntrada
 *   2. Por cliente: leer PDFs SAC y DECEVAL de su carpeta        → carpetaCliente
 *      + contactos CSV, vehículos, correo del juzgado            → ramaJudicial
 *   3. Llenar la Plantilla Singular XLSX                          → plantillaXlsx
 *   4. Generar una demanda Word por cliente                       → demandas
 *
 * Exporta: procesarSingular(excelBuffer, options?) → Promise<{ success, xlsxBuffer, clientes, errores }>
 *
 * options: {
 *   sacDocsDir?:      string  // carpeta de documentos (default: config.OUT_DIR)
 *   plantillaPath?:   string  // plantilla xlsx (default: config.PLANTILLA_SINGULAR)
 *   demandaTemplate?: string  // plantilla docx (default: config.PLANTILLA_DEMANDA)
 *   fechaAsignacion?: string  // DD/MM/YYYY, por defecto hoy
 * }
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const config = require('../../config');
const { parseAnyDate, todayString }   = require('../../utils/fechas');
const { calcularCuantia, tipoCuantia } = require('../../domain/cuantia');
const { parsearVehiculos }             = require('../../domain/vehiculos');

const { parsearExcelEntrada }          = require('./excelEntrada');
const { construirFilas, fillTemplate } = require('./plantillaXlsx');
const { loadRamaCache, buscarCorreoJuzgado } = require('./ramaJudicial');
const { leerContactos, leerDatosDeSACPdfs, leerDatosDeDeceval } = require('./carpetaCliente');
const { generarDemandasWord }          = require('./demandas');
const { consultarPlacaRunt }           = require('../runt');

async function procesarSingular(excelBuffer, options = {}) {
  const sacDocsDir      = options.sacDocsDir      || config.OUT_DIR;
  const plantillaPath   = options.plantillaPath   || config.PLANTILLA_SINGULAR;
  const demandaTemplate = options.demandaTemplate || config.PLANTILLA_DEMANDA;
  // Convertir fecha de asignación al formato texto "12 de Mayo del 2026"
  const fechaAsig       = parseAnyDate(options.fechaAsignacion) || todayString();
  const cacheFile       = path.join(sacDocsDir, 'rama_judicial_cache.json');

  loadRamaCache(cacheFile);

  // 1. Parsear Excel de entrada (mapeo de columnas: heurística + Ollama local)
  let clientes;
  try {
    clientes = await parsearExcelEntrada(excelBuffer);
  } catch (e) {
    return { success: false, error: `Error leyendo Excel: ${e.message}`, clientes: [], errores: [] };
  }

  if (clientes.length === 0) {
    return { success: false, error: 'No se encontraron clientes con cédula en Hoja1', clientes: [], errores: [] };
  }

  console.error(`[SINGULAR] ${clientes.length} cliente(s) candidato(s) — se validará el certificado DECEVAL de cada pagaré`);

  // 2. Lanzar Puppeteer para Rama Judicial
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--window-size=1280,900',
      ],
    });
  } catch (e) {
    console.error(`[RAMA] Puppeteer no disponible: ${e.message}. Se omitirán correos de juzgado.`);
    browser = null;
  }

  const filasTodas   = [];  // una fila principal por cliente (→ Hoja1)
  const filasExtras  = [];  // vehículos adicionales de cada cliente (→ Hoja2)
  const demandaItems = [];  // { fila, vehiculos } por cliente (→ demanda Word)
  const clientesSalida = [];
  const omitidos = [];      // clientes sin certificado DECEVAL válido
  const errores = [];

  try {
    for (const cliente of clientes) {
      try {
        const { cedula } = cliente;

        // 2a. Leer PDFs SAC ya descargados (fecha mora más antigua)
        const sacPdf = await leerDatosDeSACPdfs(cedula, sacDocsDir);

        // 2b. Leer PDF DECEVAL / PAGARÉ (número de pagaré + fecha suscripción
        //     + fecha de certificación + validez del certificado)
        const decevalPdf = await leerDatosDeDeceval(cedula, sacDocsDir);

        // ── FILTRO: solo clientes con certificado DECEVAL auténtico ─────
        // (texto extraíble con los marcadores del certificado; quedan fuera
        //  fotos/escaneados, formatos en blanco y clientes sin pagaré)
        if (!decevalPdf.certificadoValido) {
          const motivo = decevalPdf.tienePdf
            ? 'pagaré no es certificado DECEVAL válido (escaneado, foto o formato en blanco)'
            : 'sin pagaré DECEVAL en la carpeta del cliente';
          console.error(`[SINGULAR] ⊘ ${cedula} — ${cliente.nombre || '(sin nombre)'}: ${motivo}`);
          omitidos.push({ cedula, nombre: cliente.nombre || '', motivo });
          continue;
        }

        // ── Enriquecer nombre desde SAC PDF ────────────────────────────
        // (La información laboral — empresa y NIT — viene EXCLUSIVAMENTE del
        //  Excel de entrada y solo si trae NIT confiable; sin fallback del SAC.)
        if (!cliente.nombre && sacPdf.nombre) cliente.nombre = sacPdf.nombre;

        // ── FECHA MORA: siempre del SAC PDF (fecha inicio mora más antigua).
        //    Solo usar Excel como último recurso.
        if (sacPdf.fechaMora) {
          cliente.fechaMoraRaw = sacPdf.fechaMora; // SAC PDF tiene prioridad
        }
        // Sin fecha mora del SAC (cliente sin mora aún) → dejar la del Excel

        // ── FECHA SUSCRIPCION: del PDF DECEVAL/PAGARÉ (cuando firmó el cliente).
        //    Prioridad: DECEVAL PDF > Excel FECHA_DESEMBOLSO
        if (decevalPdf.fechaSuscripcion) {
          cliente.fechaDesembolsoRaw = decevalPdf.fechaSuscripcion;
        }

        // ── Financieros (fallback desde SAC PDF si Excel no los tiene) ──
        const f = cliente.financieros || { capital: 0, interes: 0, total: 0, obligacion: '' };
        if (!f.capital && sacPdf.capital) f.capital = sacPdf.capital;
        if (!f.interes && sacPdf.interes) f.interes = sacPdf.interes;
        if (!f.total   && sacPdf.total)   f.total   = sacPdf.total;

        // Ciudad del juzgado: preferir PDF SAC (más precisa) sobre Excel
        const ciudad = sacPdf.ciudadJuzgado || cliente.ciudad;

        // 2c. Datos financieros consolidados
        const totalCuant = f.total || calcularCuantia(f.capital, f.interes);
        const cuantiaLbl = tipoCuantia(totalCuant);

        // 2d. Parsear vehículos. Tres formatos de entrada:
        //   a) DESCRP_VS_NO_PRENDADOS con todo el detalle (uno o varios separados por &)
        //   b) Solo placa(s) en columna aparte → completar datos vía RUNT (best-effort)
        //   c) Sin vehículos
        const vehiculos = parsearVehiculos(cliente.descrVehiculos);
        if (vehiculos.length === 0 && (cliente.placas || []).length > 0) {
          for (const placa of cliente.placas) {
            const runt = browser ? await consultarPlacaRunt(browser, placa, cedula) : null;
            // Sin datos del RUNT el vehículo queda solo con la placa
            vehiculos.push(runt || { placa });
          }
        }
        const tieneVehiculos = vehiculos.length > 0;
        // Sin vehículos → un objeto vacío para rellenar la fila principal del Excel
        if (vehiculos.length === 0) vehiculos.push({});

        // 2e. Leer CONTACTOS CSV
        const contactos = leerContactos(cedula, sacDocsDir);

        // DIRECCION DE RESIDENCIA — prioridad:
        //   1. Excel de entrada (columna "direccion" de Hoja1)
        //   2. Pagaré DECEVAL (campo "Dirección:" del otorgante)
        //   3. SAC: dirección con fecha de último uso más reciente
        //   4. Primera dirección del CSV (comportamiento anterior, último recurso)
        contactos.direccion = cliente.direccion
          || decevalPdf.direccion
          || contactos.direccionSacUltimoUso
          || contactos.direccion
          || '';

        // 2f. Correo juzgado (Rama Judicial) + tipo de juzgado disponible en la ciudad
        let correoJuzgado = '';
        let courtInfo     = { hasSmallClaims: false, hasPromiscuo: false };
        if (browser) {
          try {
            const ramaResult = await buscarCorreoJuzgado(browser, ciudad, cuantiaLbl, cacheFile);
            correoJuzgado    = ramaResult.email;
            courtInfo        = { hasSmallClaims: ramaResult.hasSmallClaims, hasPromiscuo: ramaResult.hasPromiscuo };
          } catch (e) {
            console.error(`[RAMA] ${cedula} (${ciudad}): ${e.message}`);
          }
        }

        // 2g. Construir fila principal + extras (vehículos adicionales → Hoja2)
        const clienteConsolidado = { ...cliente, ciudad, financieros: f };
        const { main, extras } = construirFilas(
          clienteConsolidado, vehiculos, contactos, correoJuzgado,
          fechaAsig, cuantiaLbl, decevalPdf.numeroPagare, courtInfo,
          decevalPdf.fechaCertificacion
        );
        filasTodas.push(main);
        filasExtras.push(...extras);
        // Lista REAL de vehículos para la demanda (vacía si el cliente no tiene):
        // una medida cautelar por vehículo, o ninguna si no hay.
        demandaItems.push({ fila: main, vehiculos: tieneVehiculos ? vehiculos : [] });

        clientesSalida.push({
          cedula,
          nombre:         clienteConsolidado.nombre,
          ciudad,
          cuantia:        cuantiaLbl,
          valorCuantia:   totalCuant,
          // OBLIGACION = número del pagaré (certificado DECEVAL)
          obligacion:     decevalPdf.numeroPagare || f.obligacion,
          numeroPagare:   decevalPdf.numeroPagare,
          tipoJuzgadoFinal: main['TIPO DE JUZGADO'],
          vehiculos:      vehiculos.length,
          tieneContactos: !!(contactos.direccion || contactos.email),
          correoJuzgado,
          filas:          1 + extras.length,
        });

        console.error(`[SINGULAR] ✓ ${cedula} — ${clienteConsolidado.nombre || '(sin nombre)'} — ${cuantiaLbl} — ${main['TIPO DE JUZGADO']} — ${vehiculos.length} veh.${extras.length ? ` (${extras.length} en Hoja2)` : ''}`);

      } catch (clienteErr) {
        console.error(`[SINGULAR] ✗ ${cliente.cedula}: ${clienteErr.message}`);
        errores.push({ cedula: cliente.cedula, error: clienteErr.message });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (filasTodas.length === 0) {
    return {
      success: false,
      error:   omitidos.length
        ? `Ningún cliente tiene certificado DECEVAL válido (${omitidos.length} omitido(s))`
        : 'No se generaron filas de salida (revise los datos de entrada)',
      clientes: clientesSalida,
      omitidos,
      errores,
    };
  }

  // 3. Llenar plantilla Excel y devolver buffer XLSX
  let xlsxBuffer;
  try {
    xlsxBuffer = fillTemplate(filasTodas, plantillaPath, filasExtras);
  } catch (e) {
    return {
      success: false,
      error:   `Error generando Excel: ${e.message}`,
      clientes: clientesSalida,
      errores,
    };
  }

  // 4. Generar un DOCX de demanda por cliente (guarda en {SAC_OUT_DIR}/{cedula}/)
  let demandasGeneradas = [];
  if (fs.existsSync(demandaTemplate)) {
    try {
      demandasGeneradas = await generarDemandasWord(demandaItems, sacDocsDir, demandaTemplate);
      console.error(`[DEMANDA] ${demandasGeneradas.length} documento(s) Word generado(s)`);
    } catch (e) {
      console.error(`[DEMANDA] Error generando documentos Word: ${e.message}`);
    }
  } else {
    console.error(`[DEMANDA] Plantilla DOCX no encontrada, se omite: ${demandaTemplate}`);
  }

  if (omitidos.length) {
    console.error(`[SINGULAR] ${omitidos.length} cliente(s) omitido(s) por certificado DECEVAL inválido o ausente`);
  }

  return {
    success:          true,
    xlsxBuffer,
    totalFilas:       filasTodas.length,
    totalExtras:      filasExtras.length,
    clientes:         clientesSalida,
    omitidos:         omitidos.length ? omitidos : undefined,
    demandas:         demandasGeneradas,
    errores:          errores.length ? errores : undefined,
  };
}

module.exports = { procesarSingular, generarDemandasWord };
