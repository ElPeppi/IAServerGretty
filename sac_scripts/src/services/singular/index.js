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
 *   correoPoderBuffer?: Buffer // correo PDF del banco (mismo para todo el lote)
 *                              // sobre el que se sobrepone el poder → ANEXO 1
 *   soloCedulas?:     string[] // si viene, SOLO se procesan esas cédulas (regenerar una demanda)
 *   correcciones?:    { [cedula]: { numeroPagare?, fechaSuscripcion? } }
 *                              // datos capturados a mano que MANDAN sobre lo leído
 *                              // (pagaré escaneado: el OCR no lee el nº impreso ni
 *                              //  la fecha manuscrita)
 * }
 */

'use strict';

const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const config = require('../../config');
const { resolverCarpetaCedula }       = require('../../utils/carpetas');
const { renombrarPagarePDFs }         = require('../zips');
const { parseAnyDate, todayString }   = require('../../utils/fechas');
const { calcularCuantia, tipoCuantia } = require('../../domain/cuantia');
const { parsearVehiculos }             = require('../../domain/vehiculos');

const { parsearExcelEntrada }          = require('./excelEntrada');
const { construirFilas, fillTemplate } = require('./plantillaXlsx');
const { loadRamaCache, buscarCorreoJuzgado } = require('./ramaJudicial');
const { leerContactos, leerDatosDeSACPdfs, leerDatosDeDeceval, datacreditoTieneCorreos,
        leerCorreosDeDatacredito } = require('./carpetaCliente');
const { generarDemandasWord }          = require('./demandas');
const { generarAntecedentes }          = require('./antecedentes');
const { generarAnexos }                = require('./anexos');
const { generarPoderes }               = require('./poderes');
const { determinarLocalidad }          = require('./localidadBarranquilla');
const { consultarPlacaRunt, cerrarWorker } = require('../runt');
const { cerrarOcr }                        = require('../ocr');
const { consultarCamaraRues }          = require('../rues');

/**
 * Normaliza el mapa de datos manuales a { [cedula]: { numeroPagare, fechaSuscripcion } },
 * con las cédulas como string sin espacios y los valores recortados. Acepta que
 * venga vacío/indefinido (el caso normal: no hay nada capturado a mano).
 */
function normalizarCorrecciones(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [ced, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const numeroPagare     = String(val.numeroPagare     ?? '').trim();
    const fechaSuscripcion = String(val.fechaSuscripcion ?? '').trim();
    if (!numeroPagare && !fechaSuscripcion) continue;
    out[String(ced).trim()] = { numeroPagare, fechaSuscripcion };
  }
  return out;
}

async function procesarSingular(excelBuffer, options = {}) {
  const sacDocsDir      = options.sacDocsDir      || config.OUT_DIR;
  const plantillaPath   = options.plantillaPath   || config.PLANTILLA_SINGULAR;
  const demandaTemplate = options.demandaTemplate || config.PLANTILLA_DEMANDA;
  const poderTemplate   = options.poderTemplate   || config.PLANTILLA_PODER;
  const correoPoderBuf  = options.correoPoderBuffer || null;  // correo del banco → ANEXO 1
  const smmv            = options.smmv || undefined;          // salario mínimo (umbrales de cuantía)
  const transitoDir     = Array.isArray(options.transito) ? options.transito : []; // directorio ciudad→{entidad,correo}
  // Convertir fecha de asignación al formato texto "12 de Mayo del 2026"
  const fechaAsig       = parseAnyDate(options.fechaAsignacion) || todayString();
  const cacheFile       = path.join(sacDocsDir, 'rama_judicial_cache.json');
  // Datos capturados a mano, por cédula. Ganan a lo que lea el motor.
  const correcciones    = normalizarCorrecciones(options.correcciones);

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

  // Filtro opcional: regenerar SOLO ciertas cédulas (botón "Regenerar demanda").
  // Se conserva la propiedad `omitidosProceso` del array, filtrada a las mismas cédulas.
  if (Array.isArray(options.soloCedulas) && options.soloCedulas.length) {
    const set = new Set(options.soloCedulas.map(c => String(c).trim()));
    const omitidosProc = clientes.omitidosProceso;
    clientes = clientes.filter(c => set.has(String(c.cedula).trim()));
    clientes.omitidosProceso = Array.isArray(omitidosProc)
      ? omitidosProc.filter(o => set.has(String(o.cedula).trim()))
      : [];
    console.error(`[SINGULAR] Filtro soloCedulas → ${clientes.length} cliente(s) de ${set.size} cédula(s) pedida(s)`);
    if (clientes.length === 0) {
      return { success: false, error: `Las cédulas pedidas no están en el Excel de asignación: ${[...set].join(', ')}`, clientes: [], errores: [] };
    }
  }

  console.error(`[SINGULAR] ${clientes.length} cliente(s) candidato(s) — se validará el certificado DECEVAL de cada pagaré`);

  // 2. Lanzar Puppeteer para Rama Judicial
  let browser;
  try {
    browser = await puppeteer.launch({
      // headless: 'new' — el modo viejo no renderiza el reporte Power BI de la
      // Rama Judicial (el slicer CIUDAD nunca aparece y todo cae a CIVIL MUNICIPAL).
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1600,1000',
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
  const omitidos = [];      // clientes sin pagaré usable o con proceso ≠ ejecutivo singular
  // Cédulas excluidas en el Excel por no ser proceso "ejecutivo singular"
  if (Array.isArray(clientes.omitidosProceso) && clientes.omitidosProceso.length) {
    omitidos.push(...clientes.omitidosProceso);
    console.error(`[SINGULAR] ${clientes.omitidosProceso.length} cédula(s) omitida(s) por proceso ≠ ejecutivo singular`);
  }
  const errores = [];

  try {
    for (const cliente of clientes) {
      try {
        const { cedula } = cliente;
        // Datos capturados a mano para esta cédula (nº de pagaré, fecha de
        // suscripción): mandan sobre lo que lea el motor.
        const manual = correcciones[String(cedula).trim()] || {};
        // Notas de procedencia/avisos por cliente → se adjuntan a la demanda
        // (de dónde salió cada dato, qué faltó). { campo, nivel, mensaje }
        const notas = [];
        const runtSinInfo = [];
        const runtNoMatch = [];

        // 2·0. Normalizar nombres de pagaré: si el usuario subió el PDF con un nombre
        // cualquiera, se renombra a "{NOMBRE} PAGARE.pdf" para que la generación de
        // anexos lo encuentre (busca el pagaré por nombre). A prueba de todo método de
        // subida. Falla suave: un error aquí no detiene la generación del cliente.
        try {
          await renombrarPagarePDFs(cedula, resolverCarpetaCedula(sacDocsDir, cedula));
        } catch (e) {
          console.error(`[SINGULAR] ${cedula}: renombrado de pagaré falló (${e.message})`);
        }

        // 2a. Leer PDFs SAC ya descargados (fecha mora más antigua)
        const sacPdf = await leerDatosDeSACPdfs(cedula, sacDocsDir);

        // 2b. Leer PDF DECEVAL / PAGARÉ (número de pagaré + fecha suscripción
        //     + fecha de certificación + validez del certificado)
        const decevalPdf = await leerDatosDeDeceval(cedula, sacDocsDir);

        // ── TIPO DE PAGARÉ ──────────────────────────────────────────────
        //   DECEVAL   → certificado con texto (pagaré desmaterializado).
        //   FINANDINA → pagaré escaneado del banco (datos por OCR; el nº de
        //               pagaré = OBLIGACION del Excel). Misma plantilla.
        // Se omite solo si no hay un pagaré usable (ni certificado ni escaneado).
        if (!decevalPdf.certificadoValido && decevalPdf.tipoPagare !== 'FINANDINA') {
          const motivo = decevalPdf.tienePdf
            ? 'pagaré no es certificado DECEVAL válido ni escaneado legible (formato en blanco)'
            : 'sin pagaré en la carpeta del cliente';
          console.error(`[SINGULAR] ⊘ ${cedula} — ${cliente.nombre || '(sin nombre)'}: ${motivo}`);
          omitidos.push({ cedula, nombre: cliente.nombre || '', motivo });
          continue;
        }
        if (decevalPdf.tipoPagare === 'FINANDINA') {
          // Pagaré escaneado con el CUERPO sin diligenciar: aunque tenga firma o
          // datos del deudor, si le falta el cuerpo (número de pagaré, valor de
          // capital y fecha de vencimiento) NO presta mérito ejecutivo → no se
          // genera la demanda; queda en observaciones.
          if (!decevalPdf.diligenciado) {
            const motivo = 'pagaré escaneado con el cuerpo sin diligenciar (faltan número de pagaré, valor de capital y fecha de vencimiento; solo trae la firma/datos del deudor)';
            console.error(`[SINGULAR] ⊘ ${cedula} — ${cliente.nombre || '(sin nombre)'}: ${motivo}`);
            omitidos.push({ cedula, nombre: cliente.nombre || '', motivo });
            continue;
          }
          const fuenteNum = manual.numeroPagare ? `capturado a mano: ${manual.numeroPagare}` : 'OBLIGACION del Excel';
          console.error(`[SINGULAR] ▣ ${cedula}: pagaré escaneado → demanda tipo FINANDINA (pagaré = ${fuenteNum})`);
          notas.push({ campo: 'pagare', nivel: 'info', mensaje: `Pagaré escaneado (FINANDINA) diligenciado: datos por OCR; nº de pagaré ${manual.numeroPagare ? 'capturado a mano' : 'tomado de la OBLIGACION del Excel'}` });
        }

        // ── Enriquecer nombre desde SAC PDF ────────────────────────────
        // (La información laboral — empresa y NIT — viene EXCLUSIVAMENTE del
        //  Excel de entrada y solo si trae NIT confiable; sin fallback del SAC.)
        if (!cliente.nombre && (sacPdf.nombre || decevalPdf.nombre)) cliente.nombre = sacPdf.nombre || decevalPdf.nombre;

        // ── FECHA MORA: siempre del SAC PDF (fecha inicio mora más antigua).
        //    Solo usar Excel como último recurso.
        if (sacPdf.fechaMora) {
          cliente.fechaMoraRaw = sacPdf.fechaMora; // SAC PDF tiene prioridad
        }
        // Sin fecha mora del SAC (cliente sin mora aún) → dejar la del Excel

        // ── FECHA SUSCRIPCION: del PDF DECEVAL/PAGARÉ (cuando firmó el cliente).
        //    Prioridad: capturada a mano > DECEVAL PDF > Excel FECHA_DESEMBOLSO
        //    (en el pagaré escaneado la fecha va manuscrita: el OCR no la lee y
        //     la demanda salía con "#####").
        if (manual.fechaSuscripcion) {
          cliente.fechaDesembolsoRaw = manual.fechaSuscripcion;
        } else if (decevalPdf.fechaSuscripcion) {
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
        const cuantiaLbl = tipoCuantia(totalCuant, smmv);

        // 2d. Parsear vehículos. Formatos de entrada:
        //   a) DESCRP_VS_NO_PRENDADOS / VHS con el detalle (uno o varios separados por &)
        //   b) Solo placa(s) en columna aparte
        //   c) Sin vehículos
        let vehiculos = parsearVehiculos(cliente.descrVehiculos);
        if (vehiculos.length === 0 && (cliente.placas || []).length > 0) {
          vehiculos = cliente.placas.map(p => ({ placa: p }));
        }

        // 2d-bis. Enriquecer CADA vehículo con datos oficiales del RUNT
        // (color, serie, motor, chasis, tipo carrocería, autoridad de tránsito).
        // Se consulta por placa + cédula del propietario (el demandado).
        if (browser && vehiculos.length > 0) {
          const clientDir = resolverCarpetaCedula(sacDocsDir, cedula);
          if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
          const vehiculosValidos = [];
          for (const v of vehiculos) {
            const placaCorta = (String(v.placa || '').match(/^([A-Z0-9]{5,7})/i) || [])[1];
            if (!placaCorta) { vehiculosValidos.push(v); continue; } // sin placa → no se puede verificar, se conserva
            // pdfPath con "RUNT" en el nombre → lo recoge generarAnexos para el anexo del RUNT.
            const pdfPath = path.join(clientDir, `SAC_${cedula}_RUNT_${placaCorta}.pdf`);
            const runt = await consultarPlacaRunt(browser, placaCorta, cedula, { pdfPath });
            // No-match: la placa NO corresponde al demandado → se EXCLUYE de la demanda
            // y de los anexos (no es un vehículo del cliente). Se borra el PDF si quedó.
            if (runt && runt.noMatch) {
              runtNoMatch.push(placaCorta);
              try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (_) {}
              continue; // no se agrega a vehiculosValidos → desaparece de la demanda/anexos
            }
            // Fallo de consulta (captcha/RUNT caído): no se sabe si la placa es válida
            // → se CONSERVA el vehículo (queda el placeholder del anexo del RUNT).
            if (!runt) { runtSinInfo.push(placaCorta); vehiculosValidos.push(v); continue; }
            // RUNT es la fuente autoritativa de los datos oficiales del vehículo
            for (const campo of ['marca', 'linea', 'modelo', 'color', 'serie', 'motor', 'chasis', 'tipoCarroceria']) {
              if (runt[campo]) v[campo] = runt[campo];
            }
            if (!v.clase && runt.clase)       v.clase    = runt.clase;
            if (!v.servicio && runt.servicio) v.servicio = runt.servicio;
            v.runtAutoridad = runt.autoridad || ''; // organismo de tránsito (→ STRIA)
            vehiculosValidos.push(v);
          }
          // Reemplazar la lista por la filtrada (sin las placas que no corresponden).
          vehiculos = vehiculosValidos;
        }

        const tieneVehiculos = vehiculos.length > 0;
        // Sin vehículos → un objeto vacío para rellenar la fila principal del Excel
        if (vehiculos.length === 0) vehiculos.push({});

        // 2e. Leer CONTACTOS CSV
        const contactos = leerContactos(cedula, sacDocsDir);

        // Correos del PDF de DataCrédito. El CSV solo trae los que capturó el
        // scraping del SAC; si el DataCrédito se subió a mano (o el SAC no los
        // listó), sus correos no llegaban a la demanda aunque estén en el anexo.
        try {
          const correosDc = await leerCorreosDeDatacredito(cedula, sacDocsDir);
          const nuevos = correosDc.filter(
            (c) => !contactos.emails.some((e) => e.toLowerCase() === c),
          );
          if (nuevos.length) {
            contactos.emails = [...contactos.emails, ...nuevos];
            contactos.email = contactos.emails.join(' - ');
            console.error(`[DATACREDITO] ${cedula}: ${nuevos.length} correo(s) añadido(s) desde el PDF`);
            notas.push({
              campo: 'correo',
              nivel: 'info',
              mensaje: `${nuevos.length} correo(s) tomados del PDF de DataCrédito: ${nuevos.join(', ')}`,
            });
          }
        } catch (e) {
          console.error(`[DATACREDITO] ${cedula}: no se pudieron añadir correos: ${e.message}`);
        }

        // DIRECCION DE RESIDENCIA — prioridad:
        //   1. Excel de entrada (columna "direccion" de Hoja1)
        //   2. Pagaré DECEVAL (campo "Dirección:" del otorgante)
        //   3. SAC: dirección con fecha de último uso más reciente
        //   4. Primera dirección del CSV (comportamiento anterior, último recurso)
        let dirFuente = '';
        if (cliente.direccion)                  { contactos.direccion = cliente.direccion;                  dirFuente = 'Excel de entrada'; }
        else if (decevalPdf.direccion)          { contactos.direccion = decevalPdf.direccion;               dirFuente = 'pagaré DECEVAL'; }
        else if (contactos.direccionSacUltimoUso){ contactos.direccion = contactos.direccionSacUltimoUso;    dirFuente = 'SAC (dirección de último uso)'; }
        else if (contactos.direccion)           { dirFuente = 'CSV de contactos'; }
        if (dirFuente)
          notas.push({ campo: 'direccion', nivel: 'info', mensaje: `Dirección de residencia tomada de: ${dirFuente}` });
        else
          notas.push({ campo: 'direccion', nivel: 'warning', mensaje: 'No se encontró dirección de residencia del demandado' });

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

        // 2f-bis. Cámara de Comercio del empleador (RUES) — para el punto 5 de
        // pruebas y anexos. Solo si hay info laboral (empresa + NIT).
        let camaraEmpleador = '';
        if (browser && cliente.empresa && cliente.nitEmpresa) {
          try {
            camaraEmpleador = await consultarCamaraRues(browser, cliente.nitEmpresa);
          } catch (e) {
            console.error(`[RUES] ${cedula}: ${e.message}`);
          }
        }

        // 2g-bis. Barranquilla + pequeñas causas: la ciudad del juzgado lleva la
        // localidad → "BARRANQUILLA LOCALIDAD {LOCALIDAD}", según el barrio del demandado.
        let ciudadJuzgado = ciudad;
        if (/^BARRANQUILLA\b/i.test(ciudad) && courtInfo.hasSmallClaims) {
          const loc = await determinarLocalidad(contactos.direccion);
          if (loc) {
            ciudadJuzgado = `BARRANQUILLA LOCALIDAD ${loc}`;
          } else {
            // No se pudo determinar la localidad → dejar "#######" en su lugar para
            // que en la demanda se vea el faltante y el usuario la complete a mano.
            ciudadJuzgado = 'BARRANQUILLA LOCALIDAD #######';
            notas.push({ campo: 'localidad', nivel: 'warning', mensaje: 'Barranquilla con pequeñas causas pero no se pudo determinar la localidad por el barrio/dirección: se dejó "LOCALIDAD #######" en la demanda para completar manualmente' });
          }
        }

        // 2g. Construir fila principal + extras (vehículos adicionales → Hoja2)
        // Número de pagaré: capturado a mano → manda; DECEVAL → del certificado;
        // FINANDINA → OBLIGACION del Excel (que NO es el nº impreso en el pagaré,
        // solo el más cercano que tenemos cuando el OCR no lo lee).
        const numeroPagareFinal = manual.numeroPagare
          ? manual.numeroPagare
          : (decevalPdf.certificadoValido ? decevalPdf.numeroPagare : (f.obligacion || ''));
        const clienteConsolidado = { ...cliente, ciudad: ciudadJuzgado, financieros: f };
        const { main, extras } = construirFilas(
          clienteConsolidado, vehiculos, contactos, correoJuzgado,
          fechaAsig, cuantiaLbl, numeroPagareFinal, courtInfo,
          decevalPdf.fechaCertificacion
        );
        // Correo del organismo de tránsito (oficio de embargo del vehículo) desde el
        // directorio configurable, por ciudad. Solo aplica si el demandado tiene vehículos.
        if (tieneVehiculos) {
          if (transitoDir.length) {
            const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
            const cityKey = norm(ciudad);
            const hit = transitoDir.find((t) => {
              const tk = norm(t.ciudad);
              return tk && cityKey && (tk === cityKey || cityKey.includes(tk) || tk.includes(cityKey));
            });
            if (hit) {
              if (!String(main['DIRECCION ELECTRONICA DEL TRANSITO'] || '').trim() && hit.correo)
                main['DIRECCION ELECTRONICA DEL TRANSITO'] = hit.correo;
              if (!String(main['STRIA MCPAL\nTTOyTTE'] || '').trim() && hit.entidad)
                main['STRIA MCPAL\nTTOyTTE'] = hit.entidad;
              notas.push({ campo: 'transito', nivel: 'info', mensaje: `Tránsito: ${main['STRIA MCPAL\nTTOyTTE'] || '-'} · ${main['DIRECCION ELECTRONICA DEL TRANSITO'] || '-'} (del directorio de configuración, ciudad ${ciudad})` });
            }
          }
          if (!String(main['DIRECCION ELECTRONICA DEL TRANSITO'] || '').trim())
            notas.push({ campo: 'transito', nivel: 'warning', mensaje: `No se encontró el correo del organismo de tránsito para ${ciudad} en el directorio de configuración (revisar Configuración → Direcciones de tránsito)` });
        }
        filasTodas.push(main);
        filasExtras.push(...extras);
        // ¿El DataCrédito trae la tabla de correos? Si NO, no se anexa ni se
        // menciona en la demanda (solo sirve por las direcciones electrónicas).
        const dcCorreos = await datacreditoTieneCorreos(cedula, sacDocsDir);
        if (!dcCorreos)
          notas.push({ campo: 'datacredito', nivel: 'info', mensaje: 'El DataCrédito no trae la tabla de correos electrónicos: se omite del anexo y de su mención en la demanda' });
        // Lista REAL de vehículos para la demanda (vacía si el cliente no tiene):
        // una medida cautelar por vehículo, o ninguna si no hay.
        // tieneInmueble controla la medida cautelar PRIMERO (embargo de inmuebles).
        demandaItems.push({
          fila: main,
          vehiculos: tieneVehiculos ? vehiculos : [],
          tieneInmueble: !!cliente.tieneInmueble,
          camaraEmpleador,   // ciudad de la Cámara de Comercio del empleador (RUES)
          tipoPagare: decevalPdf.tipoPagare || 'DECEVAL',  // DECEVAL | FINANDINA
          datacreditoCorreos: dcCorreos,
        });

        // ── Notas consolidadas de procedencia / faltantes ──────────────
        if (cliente.empresa && cliente.nitEmpresa) {
          if (camaraEmpleador)
            notas.push({ campo: 'camaraEmpleador', nivel: 'info', mensaje: `Cámara de Comercio del empleador (RUES): ${camaraEmpleador}` });
          else
            notas.push({ campo: 'camaraEmpleador', nivel: 'warning', mensaje: `No contamos con la Cámara de Comercio del lugar donde trabaja (${cliente.empresa}, NIT ${cliente.nitEmpresa}): no se encontró en RUES` });
        } else if (cliente.empresa && !cliente.nitEmpresa) {
          notas.push({ campo: 'camaraEmpleador', nivel: 'warning', mensaje: `Empleador "${cliente.empresa}" sin NIT en el Excel: no se pudo consultar la Cámara de Comercio` });
        }
        if (runtSinInfo.length)
          notas.push({ campo: 'runt', nivel: 'warning', mensaje: `RUNT sin información para placa(s): ${runtSinInfo.join(', ')} (datos del vehículo incompletos)` });
        if (runtNoMatch.length)
          notas.push({ campo: 'runt', nivel: 'warning', mensaje: `Placa(s) ${runtNoMatch.join(', ')} NO corresponden al demandado según el RUNT: se excluyeron de la demanda y de los anexos` });
        if (browser && !correoJuzgado)
          notas.push({ campo: 'correoJuzgado', nivel: 'warning', mensaje: `No se encontró el correo del juzgado de ${ciudad} en la Rama Judicial` });
        if (!correoPoderBuf)
          notas.push({ campo: 'anexos', nivel: 'warning', mensaje: 'Faltó el poder en los anexos (no se adjuntó el correo del banco)' });

        // ── Procedencia completa: de dónde salió cada dato (info) ──────
        const cop = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
        notas.push({ campo: 'demandado',       nivel: 'info', mensaje: `Demandado: ${clienteConsolidado.nombre || '-'} · CC ${cedula}` });
        notas.push({ campo: 'tipoPagare',      nivel: 'info', mensaje: `Tipo de pagaré: ${decevalPdf.tipoPagare || 'DECEVAL'}${decevalPdf.tipoPagare === 'FINANDINA' ? ' (escaneado, datos por OCR)' : ' (certificado con texto)'}` });
        const origenPagare = manual.numeroPagare
          ? 'capturado a mano'
          : (decevalPdf.certificadoValido ? 'del certificado DECEVAL' : 'de la OBLIGACION del Excel');
        notas.push({
          campo: 'numeroPagare',
          // Sin captura manual y con pagaré escaneado, el número que sale es el de
          // la obligación, NO el impreso en el pagaré: eso es un aviso, no un dato.
          nivel: (!manual.numeroPagare && !decevalPdf.certificadoValido) ? 'warning' : 'info',
          mensaje: `Nº de pagaré: ${numeroPagareFinal || '-'} (${origenPagare})`
            + ((!manual.numeroPagare && !decevalPdf.certificadoValido)
              ? ' — el OCR no lee el número impreso del pagaré escaneado: verificarlo y capturarlo a mano si no coincide'
              : ''),
        });
        notas.push({ campo: 'cuantia',         nivel: 'info', mensaje: `Cuantía: ${cuantiaLbl} — total ${cop(totalCuant)} (umbrales con SMMV ${cop(smmv || 1750905)})` });
        notas.push({ campo: 'juzgado',         nivel: 'info', mensaje: `Juzgado: ${main['TIPO DE JUZGADO']} de ${ciudadJuzgado}` });
        notas.push({ campo: 'financieros',     nivel: 'info', mensaje: `Capital ${cop(f.capital)} · interés ${cop(f.interes)}` });
        notas.push({ campo: 'fechaAsignacion', nivel: 'info', mensaje: `Fecha de asignación: ${fechaAsig}` });
        const fechaSuscrFinal = manual.fechaSuscripcion || decevalPdf.fechaSuscripcion;
        notas.push({
          campo: 'fechaSuscripcion',
          nivel: fechaSuscrFinal ? 'info' : 'warning',
          mensaje: fechaSuscrFinal
            ? `Fecha de suscripción: ${main['FECHA DE SUSCRIPCION']} (${manual.fechaSuscripcion ? 'capturada a mano' : 'del pagaré'})`
            : 'Fecha de suscripción: no se pudo leer del pagaré (va manuscrita) — la demanda lleva "#####": capturarla a mano',
        });
        notas.push({ campo: 'fechaMora',       nivel: 'info', mensaje: `Fecha de mora: ${main['FECHA MORA'] || '-'} (${sacPdf.fechaMora ? 'del SAC' : 'del Excel'})` });

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
          notas,
        });

        console.error(`[SINGULAR] ✓ ${cedula} — ${clienteConsolidado.nombre || '(sin nombre)'} — ${cuantiaLbl} — ${main['TIPO DE JUZGADO']} — ${vehiculos.length} veh.${extras.length ? ` (${extras.length} en Hoja2)` : ''}`);

      } catch (clienteErr) {
        console.error(`[SINGULAR] ✗ ${cliente.cedula}: ${clienteErr.message}`);
        errores.push({ cedula: cliente.cedula, error: clienteErr.message });
      }
    }
  } finally {
    await cerrarWorker().catch(() => {});       // terminar worker OCR de tesseract (RUNT)
    await cerrarOcr().catch(() => {});          // terminar worker OCR de pagarés escaneados
    if (browser) await browser.close().catch(() => {});
  }

  if (filasTodas.length === 0) {
    // El motivo REAL de cada omisión (falta pagaré, proceso ≠ singular, pagaré sin
    // diligenciar…) ya viene en `omitidos`. Antes se decía siempre "ningún cliente
    // tiene certificado DECEVAL válido", que casi nunca era la causa y mandaba a
    // buscar el problema al sitio equivocado.
    const detalle = omitidos.length
      ? omitidos.map((o) => `${o.cedula}${o.nombre ? ` (${o.nombre})` : ''}: ${o.motivo}`).join(' · ')
      : '';
    return {
      success: false,
      error:   omitidos.length
        ? `No se generó ninguna demanda — ${omitidos.length} cliente(s) omitido(s). ${detalle}`
        : errores.length
          ? `No se generó ninguna demanda. ${errores.map((e) => `${e.cedula}: ${e.error}`).join(' · ')}`
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

  // 4-bis. Generar el PODER por cliente (mismos datos de la demanda)
  let poderesGenerados = [];
  if (fs.existsSync(poderTemplate)) {
    try {
      poderesGenerados = await generarPoderes(demandaItems, sacDocsDir, poderTemplate);
      console.error(`[PODER] ${poderesGenerados.length} poder(es) generado(s)`);
    } catch (e) {
      console.error(`[PODER] Error generando poderes: ${e.message}`);
    }
  } else {
    console.error(`[PODER] Plantilla PODER no encontrada, se omite: ${poderTemplate}`);
  }

  // 5. PDFs por cliente:
  //    ANTECEDENTES.pdf → direcciones (DIRYTEL) + obligaciones (OBL)
  //    ANEXOS.pdf       → carátulas + pagaré + SAC + datacrédito + certificados
  let antecedentes = 0, anexos = 0;
  for (const item of demandaItems) {
    const ced = String(item.fila['IDENTIFICACION'] || '').trim();
    if (!ced) continue;
    try {
      if (await generarAntecedentes(ced, sacDocsDir)) antecedentes++;
    } catch (e) {
      console.error(`[ANTECEDENTES] ${ced}: ${e.message}`);
    }
    try {
      // OBLIGACION = número del pagaré → carátula del ANEXO del pagaré
      // correoPoderBuf → ANEXO del poder (sobrepuesto en el correo del banco)
      // opts → condicionales (RUNT si hay vehículos; CCO empleador si hay empresa)
      //        para que la numeración coincida con las pruebas de la demanda.
      if (await generarAnexos(ced, sacDocsDir, String(item.fila['OBLIGACION'] || ''), correoPoderBuf, {
        vehiculos:          item.vehiculos,
        empresa:            item.fila['NOMBRE EMPRESA TT'],
        nit:                item.fila['NIT EMPRESA TT'],
        camaraEmpleador:    item.camaraEmpleador,
        datacreditoCorreos: item.datacreditoCorreos,
        // Obligación(es) del préstamo → carátula del pagaré: "Que respalda la obligación …"
        obligaciones:       String(item.fila['OBLIGACIONES'] || item.fila['OBLIGACION'] || ''),
      })) anexos++;
    } catch (e) {
      console.error(`[ANEXOS] ${ced}: ${e.message}`);
    }
  }
  console.error(`[ANTECEDENTES] ${antecedentes} archivo(s) | [ANEXOS] ${anexos} archivo(s)`);

  if (omitidos.length) {
    console.error(`[SINGULAR] ${omitidos.length} cliente(s) omitido(s) por certificado DECEVAL inválido o ausente`);
  }

  // 6. Empaquetar, por cliente, los archivos generados (base64) + las notas para
  //    que el backend los persista (en AWS no hay carpeta de red compartida).
  const documentos = construirDocumentos(clientesSalida, demandasGeneradas, sacDocsDir);

  return {
    success:          true,
    xlsxBuffer,
    totalFilas:       filasTodas.length,
    totalExtras:      filasExtras.length,
    clientes:         clientesSalida,
    documentos,
    omitidos:         omitidos.length ? omitidos : undefined,
    demandas:         demandasGeneradas,
    poderes:          poderesGenerados,
    errores:          errores.length ? errores : undefined,
  };
}

// Lee un archivo como { filename, mimeType, base64, relPath } o null si no existe.
// relPath = ruta relativa a sacDocsDir (la raíz del NAS) en formato posix, para
// que el backend lo sirva/sobreescriba desde el NAS (sin copiar a su disco ni a S3).
function leerArchivoB64(filePath, mimeType, sacDocsDir) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const relPath = sacDocsDir
      ? path.relative(sacDocsDir, filePath).split(path.sep).join('/')
      : undefined;
    return { filename: path.basename(filePath), mimeType, base64: fs.readFileSync(filePath).toString('base64'), relPath };
  } catch (e) {
    console.error(`[DOCS] No se pudo leer ${filePath}: ${e.message}`);
    return null;
  }
}

// Por cada cliente arma { cedula, nombre, notas, archivos: { demanda, anexos, antecedentes } }.
// La "asignación" (Excel de entrada) la añade el backend, que ya la tiene.
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function construirDocumentos(clientesSalida, demandasGeneradas, sacDocsDir) {
  return clientesSalida.map(c => {
    const dir       = resolverCarpetaCedula(sacDocsDir, c.cedula);
    const demandaP  = (demandasGeneradas.find(d => d.cedula === c.cedula) || {}).path || '';
    return {
      cedula:  c.cedula,
      nombre:  c.nombre,
      notas:   c.notas || [],
      archivos: {
        demanda:      leerArchivoB64(demandaP, MIME_DOCX, sacDocsDir),
        anexos:       leerArchivoB64(path.join(dir, 'ANEXOS.pdf'), 'application/pdf', sacDocsDir),
        antecedentes: leerArchivoB64(path.join(dir, 'ANTECEDENTES.pdf'), 'application/pdf', sacDocsDir),
      },
    };
  });
}

module.exports = { procesarSingular, generarDemandasWord };
