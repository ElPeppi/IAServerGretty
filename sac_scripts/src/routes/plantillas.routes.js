/**
 * routes/plantillas.routes.js — Insumos de generación (plantillas + certificados)
 *
 *   GET  /plantillas                    → estado de cada plantilla (existe, tamaño, hash, respaldos)
 *   POST /plantillas/:clave             → reemplaza una plantilla (multipart, campo `archivo`)
 *   POST /plantillas/:clave/restaurar   → vuelve a una versión anterior ({ archivo })
 *
 *   GET  /insumos                       → qué carpetas hacen falta y qué hay en ellas (con hash)
 *   POST /insumos/:destino              → deja un archivo en esa carpeta (multipart `archivo`)
 *
 * Los dos últimos son los que usa el backend para SINCRONIZAR DESDE DRIVE antes de
 * cada lote: el motor dice qué necesita y qué tiene, el backend compara contra Drive
 * y repone solo lo que cambió. El motor no habla con Drive — no tiene credenciales.
 *
 * Vive en el MOTOR, no en el backend, a propósito: las rutas de los insumos salen de
 * `config.js`, que es el mismo módulo que leen `demandas.js`/`poderes.js`/`anexos.js`
 * al generar. Así el archivo que se escribe es exactamente el que se va a leer; si
 * estuviera en el backend habría dos .env que se pueden desincronizar.
 *
 * No hay autenticación aquí (el motor escucha solo en 127.0.0.1); quien la pone
 * es el backend, que es el único que llama a estos endpoints.
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const multer  = require('multer');

const config = require('../config');
const { invalidarCompartidos } = require('../services/singular/anexos');

const router = express.Router();
const upload = multer({ dest: config.TEMP_DIR, limits: { fileSize: 30 * 1024 * 1024 } });

// Catálogo CERRADO. La clave que llega por HTTP se resuelve AQUÍ contra config:
// el cliente nunca manda una ruta, así que no hay forma de escribir fuera de
// la carpeta PLANTILLAS por más que se manipule la petición.
const CATALOGO = {
  demanda: {
    etiqueta: 'Demanda — ejecutivo singular',
    ruta: () => config.PLANTILLA_DEMANDA,
    tipo: 'docx',
  },
  poder: {
    etiqueta: 'Poder — ejecutivo singular',
    ruta: () => config.PLANTILLA_PODER,
    tipo: 'docx',
  },
  poder_pago_directo: {
    etiqueta: 'Poder — trámite de pago directo',
    ruta: () => config.PLANTILLA_PODER_PAGO_DIRECTO,
    tipo: 'docx',
  },
  singular: {
    etiqueta: 'Plantilla Singular (Excel intermedio)',
    ruta: () => config.PLANTILLA_SINGULAR,
    tipo: 'xlsx',
  },
  firma: {
    etiqueta: 'Firma del abogado',
    ruta: () => config.FIRMA_PATH,
    tipo: 'png',
  },
};

// Un .docx/.xlsx es un ZIP; un .doc viejo (o un PDF) renombrado NO lo es. Validar
// la firma del archivo evita que una plantilla inválida se descubra a mitad de un
// lote con un error críptico de AdmZip.
const FIRMAS = {
  docx: { ext: '.docx', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), desc: 'Word (.docx)' },
  xlsx: { ext: '.xlsx', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), desc: 'Excel (.xlsx)' },
  png:  { ext: '.png',  magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), desc: 'imagen PNG' },
  pdf:  { ext: '.pdf',  magic: Buffer.from('%PDF'),                   desc: 'PDF' },
};

// Se guardan las últimas versiones para poder devolverse si la plantilla nueva
// trae los marcadores «CAMPO» movidos y las demandas salen con huecos.
const RESPALDOS_MAX = 5;
const dirRespaldos = (clave) =>
  path.join(path.dirname(CATALOGO[clave].ruta()), '.respaldos', clave);

const md5 = (ruta) => crypto.createHash('md5').update(fs.readFileSync(ruta)).digest('hex');

/**
 * La fecha del respaldo sale del SELLO DEL NOMBRE, no del mtime: `copyFileSync`
 * conserva la fecha del archivo original, así que el mtime dice cuándo se editó
 * la plantilla, no cuándo se reemplazó. Ordenar (y podar) por mtime podría borrar
 * el respaldo recién hecho si su contenido era viejo.
 */
function fechaDeRespaldo(archivo, ruta) {
  const m = archivo.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z__/);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  try { return fs.statSync(ruta).mtime.toISOString(); } catch (e) { return ''; }
}

function listarRespaldos(clave) {
  let nombres;
  try {
    nombres = fs.readdirSync(dirRespaldos(clave));
  } catch (e) {
    return []; // aún no se ha reemplazado nunca → no hay carpeta
  }
  return nombres
    .map((archivo) => {
      const ruta = path.join(dirRespaldos(clave), archivo);
      try {
        return { archivo, tamano: fs.statSync(ruta).size, fecha: fechaDeRespaldo(archivo, ruta) };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.archivo.localeCompare(a.archivo)); // sello ISO → más reciente primero
}

function describir(clave) {
  const item = CATALOGO[clave];
  const ruta = item.ruta();
  const info = {
    clave,
    etiqueta: item.etiqueta,
    tipo: item.tipo,
    ruta,
    archivo: path.basename(ruta),
    existe: false,
  };
  try {
    const st = fs.statSync(ruta);
    info.existe = true;
    info.tamano = st.size;
    info.modificado = st.mtime.toISOString();
    info.hash = md5(ruta);
  } catch (e) {
    // Que falte NO es un error del endpoint: es justo lo que hay que mostrar en
    // la web (plantilla sin subir) para que se sepa por qué falla la generación.
  }
  info.respaldos = listarRespaldos(clave);
  return info;
}

/** Copia la versión actual a .respaldos/{clave} y poda las más viejas. */
function respaldar(clave) {
  const ruta = CATALOGO[clave].ruta();
  if (!fs.existsSync(ruta)) return null;

  const dir = dirRespaldos(clave);
  fs.mkdirSync(dir, { recursive: true });
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(dir, `${sello}__${path.basename(ruta)}`);
  fs.copyFileSync(ruta, destino);

  for (const viejo of listarRespaldos(clave).slice(RESPALDOS_MAX)) {
    try { fs.unlinkSync(path.join(dir, viejo.archivo)); } catch (e) { /* da igual */ }
  }
  return path.basename(destino);
}

/**
 * Escritura ATÓMICA: si el proceso muere a mitad, el archivo viejo queda intacto
 * y una generación en curso nunca ve un archivo truncado. El .tmp va en la MISMA
 * carpeta porque `rename` entre sistemas de archivos distintos falla con EXDEV.
 */
function escribirAtomico(ruta, buf) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = path.join(path.dirname(ruta), `.${path.basename(ruta)}.subiendo`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, ruta);
}

/** Lee el archivo temporal de multer y valida su firma. Lanza con el motivo. */
function leerYValidar(temp, tipo) {
  const firma = FIRMAS[tipo];
  const buf = fs.readFileSync(temp);
  if (buf.length === 0) {
    const e = new Error('El archivo está vacío');
    e.status = 400;
    throw e;
  }
  if (firma && !buf.subarray(0, firma.magic.length).equals(firma.magic)) {
    // El aviso de "Documento de Google" solo aplica a los formatos ofimáticos:
    // un Doc/Sheet exportado mal es la causa habitual de que llegue algo que no
    // es un ZIP. Para un PDF o un PNG ese consejo confundiría.
    const pista = tipo === 'docx' || tipo === 'xlsx'
      ? ` Si lo bajaste de Drive, expórtalo como ${firma.ext}, no como Documento de Google.`
      : '';
    const e = new Error(`El archivo no es un ${firma.desc} válido.${pista}`);
    e.status = 400;
    throw e;
  }
  return buf;
}

// ─── Insumos: carpetas que el motor necesita pobladas ─────────────────────────
// El backend las rellena desde Drive antes de cada lote. `plantillas` va aparte
// del catálogo de arriba porque ahí los nombres son FIJOS (los exige config),
// mientras que en los anexos vale cualquier PDF que la oficina deje en la carpeta.

const DESTINOS = {
  plantillas: {
    etiqueta: 'Plantillas y firma',
    dir: () => path.dirname(config.PLANTILLA_DEMANDA),
    // Solo estos nombres; cualquier otro archivo de la carpeta de Drive se ignora.
    requeridos: () => Object.keys(CATALOGO).map((c) => path.basename(CATALOGO[c].ruta())),
    tipoDe: (nombre) => {
      const ext = path.extname(nombre).toLowerCase().replace('.', '');
      return FIRMAS[ext] ? ext : null;
    },
  },
  anexos_demandas: {
    etiqueta: 'Certificados generales (CCO J Ramos, SIRNA)',
    dir: () => config.ANEXOS_DIR_DEMANDAS,
    requeridos: () => null, // null = cualquier PDF de la carpeta
    tipoDe: () => 'pdf',
  },
  anexos_finandina: {
    etiqueta: 'Certificados Finandina (Super Financiera, CCO Finandina)',
    dir: () => config.ANEXOS_DIR_FINANDINA,
    requeridos: () => null,
    tipoDe: () => 'pdf',
  },
};

function describirDestino(clave) {
  const d = DESTINOS[clave];
  const dir = d.dir();
  const archivos = [];
  let nombres = [];
  try { nombres = fs.readdirSync(dir); } catch (e) { /* carpeta aún inexistente */ }
  for (const nombre of nombres) {
    const p = path.join(dir, nombre);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      archivos.push({ archivo: nombre, tamano: st.size, hash: md5(p) });
    } catch (e) { /* se omite */ }
  }
  return { destino: clave, etiqueta: d.etiqueta, dir, requeridos: d.requeridos(), archivos };
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

router.get('/plantillas', (_req, res) => {
  try {
    res.json({ success: true, plantillas: Object.keys(CATALOGO).map(describir) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/plantillas/:clave', upload.single('archivo'), (req, res) => {
  const clave = req.params.clave;
  const temp = req.file && req.file.path;
  try {
    if (!CATALOGO[clave]) {
      return res.status(404).json({ success: false, error: `Plantilla desconocida: ${clave}` });
    }
    if (!temp) {
      return res.status(400).json({ success: false, error: 'No llegó ningún archivo' });
    }

    const buf = leerYValidar(temp, CATALOGO[clave].tipo);
    const respaldo = respaldar(clave);
    escribirAtomico(CATALOGO[clave].ruta(), buf);
    res.json({ success: true, respaldo, plantilla: describir(clave) });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch (e) { /* temporal de multer */ } }
  }
});

router.post('/plantillas/:clave/restaurar', (req, res) => {
  const clave = req.params.clave;
  try {
    if (!CATALOGO[clave]) {
      return res.status(404).json({ success: false, error: `Plantilla desconocida: ${clave}` });
    }
    const archivo = String((req.body && req.body.archivo) || '');
    // basename(): un "../.." en el nombre no puede salir de la carpeta de respaldos.
    if (!archivo || path.basename(archivo) !== archivo) {
      return res.status(400).json({ success: false, error: 'Nombre de respaldo inválido' });
    }
    const origen = path.join(dirRespaldos(clave), archivo);
    if (!fs.existsSync(origen)) {
      return res.status(404).json({ success: false, error: 'Ese respaldo ya no existe' });
    }

    respaldar(clave); // la versión actual también se respalda: restaurar nunca pierde nada
    escribirAtomico(CATALOGO[clave].ruta(), fs.readFileSync(origen));
    res.json({ success: true, plantilla: describir(clave) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/insumos', (_req, res) => {
  try {
    res.json({ success: true, destinos: Object.keys(DESTINOS).map(describirDestino) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/insumos/:destino', upload.single('archivo'), (req, res) => {
  const destino = req.params.destino;
  const temp = req.file && req.file.path;
  try {
    const d = DESTINOS[destino];
    if (!d) return res.status(404).json({ success: false, error: `Destino desconocido: ${destino}` });
    if (!temp) return res.status(400).json({ success: false, error: 'No llegó ningún archivo' });

    // basename(): el nombre lo propone el backend (viene de Drive), pero aun así
    // se recorta para que no pueda escribir fuera de la carpeta del destino.
    const nombre = path.basename(String(req.body.nombre || req.file.originalname || ''));
    if (!nombre) return res.status(400).json({ success: false, error: 'Falta el nombre del archivo' });

    const requeridos = d.requeridos();
    if (requeridos && !requeridos.includes(nombre)) {
      return res.status(400).json({
        success: false,
        error: `"${nombre}" no es un insumo de ${destino}. Esperados: ${requeridos.join(', ')}`,
      });
    }

    const tipo = d.tipoDe(nombre);
    if (!tipo) {
      return res.status(400).json({ success: false, error: `Extensión no admitida: ${nombre}` });
    }
    const buf = leerYValidar(temp, tipo);

    // Si el archivo pertenece al catálogo de plantillas, se respalda antes de
    // pisarlo: una plantilla que llega mal desde Drive se puede deshacer.
    const clave = Object.keys(CATALOGO).find((c) => path.basename(CATALOGO[c].ruta()) === nombre);
    if (destino === 'plantillas' && clave) respaldar(clave);

    escribirAtomico(path.join(d.dir(), nombre), buf);
    // Sin esto, el certificado recién repuesto no se usaría: anexos.js cachea qué
    // PDF es el "más reciente" de cada carpeta.
    invalidarCompartidos();
    res.json({ success: true, destino, archivo: nombre, tamano: buf.length });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.message });
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch (e) { /* temporal de multer */ } }
  }
});

module.exports = router;
