/**
 * services/finandina/garantia — Orquestador del TRÁMITE DE PAGO DIRECTO
 * (garantía mobiliaria, Ley 1676/2013).
 *
 * Recorre los clientes de la asignación marcados con ese proceso y, por cada uno,
 * arma la SOLICITUD DE APREHENSIÓN Y ENTREGA a partir de los documentos que el
 * banco dejó en su carpeta.
 *
 * SE PARECE POCO AL EJECUTIVO SINGULAR, y por eso vive aparte:
 *   - los datos NO salen del Excel de la asignación sino de los documentos del
 *     banco (contrato de prenda, formularios de Confecámaras, RUNT, Servientrega);
 *   - no hay cuantía: es una "simple petición", así que el juzgado es siempre
 *     municipal, nunca circuito ni pequeñas causas;
 *   - no se genera con huecos (ver garantia/demandas.js).
 *
 * El Excel solo aporta a QUIÉN hay que procesar. Todo lo demás se lee de la
 * carpeta, que es donde está la verdad que va a ir al juzgado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const config = require('../../../config');
const { resolverCarpetaCedula } = require('../../../utils/carpetas');
const { tipoJuzgadoPagoDirecto } = require('../../../domain/cuantia');
const { parsearExcelEntrada } = require('../../comun/excelEntrada');
const { loadRamaCache, buscarCorreoJuzgado } = require('../../comun/ramaJudicial');
const { buscarEnConfig } = require('../../comun/juzgadosConfig');
const { correoSijin } = require('../../comun/sijin');
const { cerrarOcr } = require('../../ocr');
const { consultarPlacaRunt, cerrarWorker } = require('../../runt');
const { localizar, TIPOS } = require('./documentos');
const { extraer, vehiculoDeDescripcion } = require('./extraccion');
const { construirCampos, generarDemanda } = require('./demandas');
const { generarAnexos } = require('./anexos');

const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Juzgado competente: el del domicilio del GARANTE (así lo dice la propia
 * demanda). Solo hay dos posibilidades —civil o promiscuo municipal— y para
 * saber cuál hace falta conocer la especialidad de esa ciudad.
 *
 * Manda el archivo que mantiene la oficina; la Rama solo se consulta si ahí no
 * está confirmado, y si el scraping falla se cae a CIVIL MUNICIPAL, que es lo
 * que hay en la inmensa mayoría de municipios.
 */
async function resolverJuzgado(ciudad, browser, cacheFile) {
  const cfg = buscarEnConfig(ciudad, 'MINIMA');
  if (cfg.encontrado && cfg.confirmado) return tipoJuzgadoPagoDirecto(cfg.hasPromiscuo);
  if (browser) {
    try {
      const rama = await buscarCorreoJuzgado(browser, ciudad, 'MINIMA', cacheFile);
      return tipoJuzgadoPagoDirecto(!!rama.hasPromiscuo);
    } catch (e) {
      console.error(`[GARANTIA] Rama falló para ${ciudad}: ${e.message}`);
    }
  }
  return tipoJuzgadoPagoDirecto(cfg.encontrado ? cfg.hasPromiscuo : false);
}

/** Nombre del archivo, con la convención que ya usa la oficina. */
function nombreDemanda(nombre, cedula) {
  const limpio = String(nombre || cedula).trim().replace(/[<>:"/\\|?*]/g, '_');
  return `SOLICITUD DE APREHENSION DEMANDANTE BANCO FINANDINA SA BIC CONTRA ${limpio} CC ${cedula}.docx`;
}

/** Navegador headless para la Rama Judicial y/o la consulta del RUNT. */
async function lanzarBrowser() {
  return puppeteer.launch({
    // headless: 'new' — el modo viejo no renderiza el reporte Power BI de la
    // Rama (ver services/comun/ramaJudicial.js).
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
  });
}

/**
 * Cuando no hay ni CTL ni certificado del RUNT en la carpeta, intenta BAJAR el
 * RUNT del portal público (best-effort) y guardarlo en la carpeta del cliente.
 *
 * La placa sale de los formularios de Confecámaras (campo "Descripción"), que sí
 * son obligatorios; el propietario es la cédula del garante. `consultarPlacaRunt`
 * guarda la consulta como PDF con un nombre que contiene "RUNT" y cuyo contenido
 * ("PLACA DEL VEHÍCULO") pasa la detección de documentos.
 *
 * NUNCA lanza ni bloquea: el captcha del RUNT se resuelve por OCR y el portal
 * limita por IP, así que fallará en algunos. Si no baja, el cliente se omite por
 * "falta RUNT/CTL", igual que antes.
 *
 * @returns {Promise<boolean>} true si el RUNT quedó en la carpeta.
 */
async function intentarDescargarRunt(carpeta, halladas, cedula, browser) {
  const descr = `${halladas.textos.inscripcion || ''}\n${halladas.textos.ejecucion || ''}`;
  const placa = String(vehiculoDeDescripcion(descr).placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{3}\d{2,3}[A-Z]?$/.test(placa)) {
    console.error(`[GARANTIA] ${cedula}: sin placa legible en los formularios → no se puede bajar el RUNT`);
    return false;
  }
  const pdfPath = path.join(carpeta, `RUNT ${cedula}.pdf`);
  try {
    const r = await consultarPlacaRunt(browser, placa, cedula, { pdfPath });
    if (r && r.pdfPath && fs.existsSync(pdfPath)) {
      console.error(`[GARANTIA] ${cedula}: RUNT bajado del portal (${placa}) → ${path.basename(pdfPath)}`);
      return true;
    }
    console.error(`[GARANTIA] ${cedula}: no se pudo bajar el RUNT del portal (${placa}).`);
  } catch (e) {
    console.error(`[GARANTIA] ${cedula}: error bajando el RUNT: ${e.message}`);
  }
  return false;
}

function leerArchivoB64(filePath, sacDocsDir, mimeType = MIME_DOCX) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const relPath = sacDocsDir
      ? path.relative(sacDocsDir, filePath).split(path.sep).join('/')
      : undefined;
    return {
      filename: path.basename(filePath),
      mimeType,
      base64: fs.readFileSync(filePath).toString('base64'),
      relPath,
    };
  } catch (e) {
    console.error(`[GARANTIA] No se pudo leer ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * @param {Buffer} excelBuffer  Excel de la asignación (el mismo del singular)
 * @param {Object} [options]
 * @param {string} [options.sacDocsDir]    raíz de las carpetas de cliente
 * @param {string} [options.plantillaPath]
 * @param {string[]} [options.soloCedulas] procesar solo estas
 * @param {Date} [options.ahora]           para fijar la fecha en pruebas
 */
async function procesarGarantias(excelBuffer, options = {}) {
  const sacDocsDir = options.sacDocsDir || config.OUT_DIR;
  const plantilla = options.plantillaPath || config.PLANTILLA_DEMANDA_PAGO_DIRECTO;
  const cacheFile = path.join(sacDocsDir, 'rama_judicial_cache.json');

  let clientes = await parsearExcelEntrada(excelBuffer, { proceso: 'pago_directo' });
  if (options.soloCedulas && options.soloCedulas.length) {
    const set = new Set(options.soloCedulas.map(String));
    clientes = clientes.filter((c) => set.has(String(c.cedula)));
  }
  console.error(`[GARANTIA] ${clientes.length} cliente(s) de pago directo`);

  loadRamaCache(cacheFile);

  // Solo se levanta el navegador si alguna ciudad no está resuelta en el archivo
  // de la oficina. En un lote de ciudades conocidas no se abre nunca.
  let browser = null;
  const necesitaRama = clientes.some((c) => {
    const cfg = buscarEnConfig(c.ciudad, 'MINIMA');
    return !(cfg.encontrado && cfg.confirmado);
  });
  if (necesitaRama) {
    try {
      browser = await lanzarBrowser();
    } catch (e) {
      console.error(`[GARANTIA] Puppeteer no disponible: ${e.message}. El juzgado saldrá del archivo de la oficina.`);
    }
  }

  const salida = [];
  const documentos = [];
  const omitidos = [];
  const errores = [];

  try {
    for (const cliente of clientes) {
      const cedula = String(cliente.cedula);
      const quien = `${cedula} ${cliente.nombre || ''}`.trim();
      try {
        const carpeta = resolverCarpetaCedula(sacDocsDir, cedula);
        if (!carpeta || !fs.existsSync(carpeta)) {
          omitidos.push({ cedula, nombre: cliente.nombre, motivo: 'no tiene carpeta de documentos' });
          continue;
        }

        let halladas = await localizar(carpeta);

        // Sin CTL ni RUNT, y si es lo ÚNICO que falta: intentar bajar el RUNT del
        // portal (best-effort). Solo se abre el navegador y se gasta el captcha si
        // el resto del expediente ya está completo. Si baja, se re-detecta.
        if (!halladas.documentos.tradicion && !halladas.documentos.runt
            && halladas.faltantes.length === 1 && halladas.faltantes[0] === TIPOS.runt.etiqueta) {
          if (!browser) {
            try { browser = await lanzarBrowser(); }
            catch (e) { console.error(`[GARANTIA] Puppeteer no disponible para el RUNT: ${e.message}`); }
          }
          if (browser && await intentarDescargarRunt(carpeta, halladas, cedula, browser)) {
            halladas = await localizar(carpeta);
          }
        }

        if (halladas.faltantes.length) {
          const motivo = halladas.faltantes.includes(TIPOS.runt.etiqueta) && !halladas.documentos.tradicion
            ? `faltan documentos: ${halladas.faltantes.join(', ')} (no hay CTL y no se pudo bajar el RUNT)`
            : `faltan documentos: ${halladas.faltantes.join(', ')}`;
          omitidos.push({ cedula, nombre: cliente.nombre, motivo });
          console.error(`[GARANTIA] x ${quien} — faltan: ${halladas.faltantes.join(', ')}`);
          continue;
        }

        const datos = await extraer(halladas);
        const ciudad = datos.garante.municipio || cliente.ciudad || '';
        const tipoJuzgado = await resolverJuzgado(ciudad, browser, cacheFile);
        const sijin = correoSijin(ciudad, datos.garante.departamento || cliente.departamento);

        const { fieldMap, faltantes } = construirCampos({
          datos,
          tipoJuzgado,
          correoSijin: sijin && sijin.correo,
          diasMora: datos.diasMora,
          ahora: options.ahora,
        });
        if (faltantes.length) {
          omitidos.push({ cedula, nombre: cliente.nombre, motivo: `no se pudo leer: ${faltantes.join(', ')}` });
          console.error(`[GARANTIA] x ${quien} — sin datos: ${faltantes.join(', ')}`);
          continue;
        }

        // El certificado de tradición decide el ANEXO 4 (y con él, cuál de los
        // dos renglones sobra en la lista de anexos de la demanda).
        const buffer = generarDemanda(plantilla, fieldMap, {
          conTradicion: !!halladas.documentos.tradicion,
        });
        const destino = path.join(carpeta, nombreDemanda(datos.garante.nombre, cedula));
        fs.writeFileSync(destino, buffer);

        // Los anexos NO bloquean: si fallan, la demanda ya está hecha y se puede
        // armar el PDF a mano. Devolver '' y seguir es mejor que perder el lote.
        const anexos = await generarAnexos(carpeta, halladas, datos, options.correoPoderBuffer || null);

        // Trazabilidad de lo que no se pudo confirmar contra dos fuentes, para
        // que quien revise sepa dónde mirar. No bloquean: el dato está.
        const notas = [];
        if (sijin && sijin.via === 'departamento') {
          notas.push({
            campo: 'sijin',
            nivel: 'info',
            mensaje: `${ciudad} no está en el directorio SIJIN; se usó la del departamento (${sijin.correo}).`,
          });
        }
        if (!datos.vehiculo.serie) {
          notas.push({
            campo: 'serie',
            nivel: 'info',
            mensaje: 'El registro oficial (RUNT/CTL) no reporta número de serie para este vehículo.',
          });
        }

        salida.push({ cedula, nombre: datos.garante.nombre, placa: datos.vehiculo.placa, notas });
        documentos.push({
          cedula,
          nombre: datos.garante.nombre,
          notas,
          archivos: { demanda: leerArchivoB64(destino, sacDocsDir) },
        });
        console.error(`[GARANTIA] ok ${quien} — ${datos.vehiculo.placa} — ${tipoJuzgado} de ${ciudad}`);
      } catch (e) {
        errores.push({ cedula, error: e.message });
        console.error(`[GARANTIA] x ${quien}: ${e.message}`);
      }
    }
  } finally {
    await cerrarWorker().catch(() => {}); // worker OCR del captcha + página del RUNT
    if (browser) { try { await browser.close(); } catch (e) { /* se cierra igual */ } }
    await cerrarOcr().catch(() => {});
  }

  console.error(`[GARANTIA] ${salida.length} generada(s), ${omitidos.length} omitida(s), ${errores.length} con error`);
  return {
    success: true,
    total: clientes.length,
    clientes: salida,
    documentos,
    omitidos: omitidos.length ? omitidos : undefined,
    errores: errores.length ? errores : undefined,
  };
}

module.exports = { procesarGarantias, resolverJuzgado };
