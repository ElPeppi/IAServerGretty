/**
 * services/finandina/garantia/documentos.js — Encuentra los documentos que el
 * banco deja en la carpeta del cliente para el trámite de PAGO DIRECTO.
 *
 * POR QUÉ ES UN MÓDULO Y NO CUATRO LÍNEAS: los nombres no siguen ninguna
 * convención. Comparando dos carpetas reales:
 *
 *              Emily                        Jorge
 *   RUNT       RUNT.pdf                     Consulta Ciudadano - RUNT.pdf
 *   SAC        __ SAC __ v6.0.0.6.pdf       SAC 14 MARZO 2025.jpg
 *   Servient.  …titulo.pdf                  …testigo.pdf
 *   prenda     …PRENDA.pdf                  …PRENDA.pdf Y …PRENDA ok.pdf
 *   estructura subcarpeta con el nombre     todo plano
 *
 * Por eso: se busca RECURSIVAMENTE, por PALABRA CLAVE en el nombre, y se
 * CONFIRMA con el contenido. Lo del Servientrega es el caso que obliga a mirar
 * dentro: "titulo" y "testigo" no se parecen entre sí ni al documento, pero los
 * dos empiezan por "Servientrega S. A. -- Acta de Envío y Entrega".
 *
 * El contenido también desempata solo: en la carpeta de Jorge hay dos ficheros
 * con "RUNT" en el nombre y uno es un pantallazo sin texto.
 *
 * FALTA UNO = NO HAY DEMANDA. Es decisión del despacho y es la correcta: una
 * demanda con la fecha de suscripción en blanco se nota; con una fecha sacada de
 * otro sitio, no. Se aborta ESE cliente y se dice cuál faltó; los demás del lote
 * siguen.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { textoDePdf } = require('../../comun/pdfTexto');

/**
 * `claves`    — se prueba contra el nombre del archivo en MAYÚSCULAS.
 * `contenido` — debe aparecer en el texto del PDF. Confirma y desempata.
 * `escaneado` — el PDF no trae capa de texto: no se le exige `contenido` y lo
 *               leerá el OCR más adelante.
 */
const TIPOS = {
  prenda: {
    etiqueta: 'contrato de prenda',
    claves: /\bPRENDA\b/,
    escaneado: true,
  },
  inscripcion: {
    etiqueta: 'formulario de inscripción inicial (Confecámaras)',
    claves: /\bFOR(?:MATO|MULARIO)?[\s_-]*INI\b|INSCRIPCION\s*INICIAL/,
    contenido: /FORMULARIO\s*DE\s*INSCRIPCI[OÓ]N\s*INICIAL/i,
  },
  ejecucion: {
    etiqueta: 'formulario de ejecución (Confecámaras)',
    claves: /\bFOR(?:MATO|MULARIO)?[\s_-]*EJE\b|EJECUCION/,
    contenido: /FORMULARIO\s*DE\s*REGISTRO\s*DE\s*EJECUCI[OÓ]N/i,
  },
  runt: {
    etiqueta: 'certificado del RUNT',
    claves: /\bRUNT\b/,
    // Descarta el pantallazo: es una imagen con "RUNT" en el nombre y sin texto.
    contenido: /Consulta\s*Automotores|PLACA\s*DEL\s*VEH[IÍ]CULO/i,
  },
  carta: {
    etiqueta: 'carta de requerimiento al garante',
    claves: /\bCARTA\b|REQUERIMIENTO/,
    contenido: /Ejecuci[oó]n\s*de\s*Garant[ií]a\s*Mobiliaria/i,
  },
  sac: {
    etiqueta: 'consulta del SAC (días de mora)',
    // El SAC del ejecutivo singular se llama "SAC_<algo>.pdf" y el que deja el
    // banco en estas carpetas "__ SAC __ v6.0.0.6.pdf". La palabra suelta cubre
    // los dos sin casarse con ninguna convención.
    claves: /\bSAC\b/,
    contenido: /D[ií]as\s*Mora/i,
  },
  servientrega: {
    etiqueta: 'acta de envío de Servientrega',
    // Los nombres reales vistos ("titulo", "testigo") no dicen nada; el filtro
    // de verdad es el contenido, y las claves solo acotan la búsqueda.
    claves: /TITULO|TESTIGO|SERVIENTREGA|ENVIO|E-?ENTREGA/,
    contenido: /Servientrega[\s\S]{0,80}Acta\s*de\s*Env[ií]o/i,
  },
};

const ES_PDF = /\.pdf$/i;

/** Todos los PDF de la carpeta y sus subcarpetas, con su ruta completa. */
function pdfsDe(dir, profundidad = 0) {
  if (profundidad > 3) return [];       // las carpetas del despacho no anidan más
  let entradas = [];
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const e of entradas) {
    if (e.name.startsWith('~$') || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pdfsDe(p, profundidad + 1));
    else if (ES_PDF.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Entre varios candidatos del mismo tipo, el mejor.
 *
 * Gana el marcado "ok": cuando alguien rescanea un documento porque el primero
 * salió ilegible, deja el bueno con ese sufijo (en la carpeta de Jorge, PRENDA.pdf
 * tiene el recuadro del vehículo borroso y PRENDA ok.pdf no). A igualdad, el más
 * reciente.
 */
function mejor(candidatos) {
  return candidatos.sort((a, b) => {
    const okA = /\bok\b/i.test(path.basename(a.ruta)) ? 1 : 0;
    const okB = /\bok\b/i.test(path.basename(b.ruta)) ? 1 : 0;
    if (okA !== okB) return okB - okA;
    return b.mtime - a.mtime;
  })[0];
}

/**
 * Localiza los documentos del trámite en la carpeta del cliente.
 *
 * @param {string} carpeta  carpeta del cliente
 * @returns {Promise<{documentos: Object, textos: Object, faltantes: string[]}>}
 *   `documentos[tipo] = {ruta, nombre}` y `textos[tipo]` el texto ya extraído
 *   (no se vuelve a leer después). `faltantes` son las ETIQUETAS de los que no
 *   aparecieron — vacío significa que se puede generar.
 */
async function localizar(carpeta) {
  const rutas = pdfsDe(carpeta);

  // Solo se abren los que YA encajan por nombre con algún tipo. La carpeta
  // guarda también la demanda generada (41 páginas) y sus anexos: extraerles el
  // texto para descartarlos después costaría más que todo lo demás junto.
  const claves = Object.values(TIPOS).map((t) => t.claves);
  const candidatas = rutas.filter((r) => {
    const n = path.basename(r).toUpperCase();
    return claves.some((re) => re.test(n));
  });

  // Se lee el texto UNA vez por archivo: se necesita para confirmar el tipo y
  // luego para extraer los campos. Los escaneados devuelven vacío sin fallar.
  const leidos = [];
  for (const ruta of candidatas) {
    let texto = '';
    try {
      texto = (await textoDePdf(fs.readFileSync(ruta))).texto;
    } catch (e) {
      texto = '';   // PDF ilegible o solo imagen → se trata como escaneado
    }
    let mtime = 0;
    try { mtime = fs.statSync(ruta).mtimeMs; } catch (e) { /* da igual */ }
    leidos.push({ ruta, nombre: path.basename(ruta), TEXTO: texto, mtime });
  }

  const documentos = {};
  const textos = {};
  const faltantes = [];

  for (const [tipo, def] of Object.entries(TIPOS)) {
    const porNombre = leidos.filter((f) => def.claves.test(f.nombre.toUpperCase()));
    const candidatos = def.escaneado
      ? porNombre
      : porNombre.filter((f) => def.contenido.test(f.TEXTO));

    if (!candidatos.length) { faltantes.push(def.etiqueta); continue; }
    const elegido = mejor(candidatos);
    documentos[tipo] = { ruta: elegido.ruta, nombre: elegido.nombre };
    textos[tipo] = elegido.TEXTO;
  }

  return { documentos, textos, faltantes };
}

module.exports = { localizar, TIPOS };
