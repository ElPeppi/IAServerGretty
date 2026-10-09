/**
 * libertadorDrive.ts — Acceso a Drive para el flujo de poderes de Libertador.
 *
 * Los casos de Libertador viven SOLO en el Drive de la oficina, bajo:
 *   <ROOT>/DEMANDAS/LIBERTADOR/DOCUMENTOS CLIENTES/<solicitud> [MES AÑO]
 * y la plantilla del poder en:
 *   <ROOT>/DEMANDAS/LIBERTADOR/CREAR PODERES/.../PLANTILLA PODER DE CONCILIACION.docx
 *
 * Una sola carpeta por solicitud para todos sus procesos, con una subcarpeta por
 * proceso (EJECUTIVO, RESTITUCION, CONCILIACION, RESIDUAL). Lo común a todos
 * (contrato, reconocimientos, estado de cuenta) queda en la raíz de la carpeta.
 *
 * Reusa la misma auth (service account + delegación) y env que DriveStorage.
 * Se mantiene aparte para NO tocar el storage {cedula}/ de producción.
 */
import { google, drive_v3 } from 'googleapis';

const SA_KEY = process.env.DRIVE_SA_KEY || '';
const IMPERSONATE_USER = process.env.DRIVE_IMPERSONATE_USER || '';
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || '';
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || SHARED_DRIVE_ID || 'root';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true };
const SCOPE = SHARED_DRIVE_ID ? { corpora: 'drive' as const, driveId: SHARED_DRIVE_ID } : {};

let _drive: drive_v3.Drive | null = null;
function drive(): drive_v3.Drive {
  if (!_drive) {
    const auth = new google.auth.JWT({
      keyFile: SA_KEY,
      scopes: ['https://www.googleapis.com/auth/drive'],
      subject: IMPERSONATE_USER,
    });
    _drive = google.drive({ version: 'v3', auth });
  }
  return _drive;
}

export function libertadorDriveDisponible(): boolean {
  return !!(SA_KEY && IMPERSONATE_USER && (SHARED_DRIVE_ID || ROOT_FOLDER_ID !== 'root'));
}

async function listar(q: string, fields = 'files(id,name,mimeType,size)'): Promise<drive_v3.Schema$File[]> {
  const res = await drive().files.list({ q, fields, pageSize: 500, ...ALL_DRIVES, ...SCOPE });
  return res.data.files || [];
}

// Subcarpeta por nombre (exacta, luego "contiene").
async function hijoFolder(parentId: string, nameLike: string): Promise<string | null> {
  const items = await listar(
    `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    'files(id,name)',
  );
  const hit = items.find((f) => (f.name || '').toLowerCase() === nameLike.toLowerCase())
    || items.find((f) => (f.name || '').toLowerCase().includes(nameLike.toLowerCase()));
  return hit?.id || null;
}

// Navega ROOT/DEMANDAS/LIBERTADOR/<sub> y devuelve el folderId de <sub>.
async function carpetaLibertador(sub: string): Promise<string | null> {
  let p: string | null = ROOT_FOLDER_ID;
  for (const seg of ['DEMANDAS', 'LIBERTADOR', sub]) {
    p = await hijoFolder(p as string, seg);
    if (!p) return null;
  }
  return p;
}

// Carpeta que contiene UNA carpeta por caso. Es "DOCUMENTOS CLIENTES" (verificado
// contra el Drive de la oficina); queda en env por si la renombran.
const CARPETA_CASOS = process.env.LIBERTADOR_CARPETA_CASOS || 'DOCUMENTOS CLIENTES';

/**
 * Resuelve la carpeta del caso por número de solicitud dentro de esa carpeta.
 * La oficina las nombra de tres formas que conviven: "10030879", "10030879 - 2025"
 * y "11600892 SEPTIEMBRE 2025". Se prefiere el match exacto y, si hay varias, la
 * del año más reciente.
 *
 * El `name contains` va dentro de la consulta y NO se lista la carpeta entera: hoy
 * tiene 772 subcarpetas, muy por encima del tamaño de página, y un listado plano
 * devolvería `null` para las que quedaran fuera — perdiendo el archivo sin que se
 * note, porque el llamador trata "no la encontré" como un aviso, no como un error.
 */
export async function resolverCarpetaCaso(
  solicitud: string,
): Promise<{ folderId: string; folderName: string } | null> {
  const casosId = await carpetaLibertador(CARPETA_CASOS);
  if (!casosId) return null;
  const sol = String(solicitud).trim();
  if (!sol) return null;
  return buscarCarpetaCaso(casosId, sol);
}

async function buscarCarpetaCaso(
  casosId: string,
  sol: string,
): Promise<{ folderId: string; folderName: string } | null> {
  const items = await listar(
    `'${casosId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
    + ` and name contains '${sol.replace(/['\\]/g, '\\$&')}'`,
    'files(id,name)',
  );
  // Candidatas: nombre === solicitud, o empieza por ella y lo que sigue NO es otro
  // dígito ("11600892 SEPTIEMBRE 2025", "5761466 - 2025"), para no confundir 591854
  // con 5918543. Sin RegExp: la solicitud sale del cuadro, que trae filas sucias, y
  // un carácter especial haría que `new RegExp` lanzara en vez de no encontrar nada.
  const cand = items.filter((f) => {
    const n = (f.name || '').trim();
    if (n === sol) return true;
    return n.startsWith(sol) && !/[0-9]/.test(n.charAt(sol.length));
  });
  if (!cand.length) return null;

  const anio = (n: string) => { const m = n.match(/(\d{4})\s*$/); return m ? +m[1] : 0; };
  cand.sort((a, b) => {
    const ea = (a.name || '').trim() === sol ? 1 : 0;
    const eb = (b.name || '').trim() === sol ? 1 : 0;
    if (ea !== eb) return eb - ea;               // match exacto primero
    return anio(b.name || '') - anio(a.name || ''); // luego año más reciente
  });
  return { folderId: cand[0].id as string, folderName: cand[0].name as string };
}

// Procesos que puede traer una solicitud; cada uno es una subcarpeta del caso.
export const PROCESOS_LIBERTADOR = ['EJECUTIVO', 'RESTITUCION', 'CONCILIACION', 'RESIDUAL'] as const;
export type ProcesoLibertador = (typeof PROCESOS_LIBERTADOR)[number];

// Sin tildes y en mayúsculas: "Restitución" y "RESTITUCION" son la misma carpeta.
const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

/** "Restitución" → 'RESTITUCION'; lo que no es un proceso conocido → null. */
export function normalizarProceso(valor: unknown): ProcesoLibertador | null {
  const v = sinTildes(String(valor ?? ''));
  return (PROCESOS_LIBERTADOR as readonly string[]).includes(v) ? (v as ProcesoLibertador) : null;
}

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
  'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/** "5918543 AGOSTO 2026": la solicitud con el mes y año (hora de Colombia) en que llegó. */
export function nombreCarpetaCaso(solicitud: string, fecha = new Date()): string {
  const partes = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: 'numeric' })
    .formatToParts(fecha);
  const mes = Number(partes.find((p) => p.type === 'month')?.value);
  const anio = partes.find((p) => p.type === 'year')?.value;
  return `${solicitud} ${MESES[mes - 1]} ${anio}`;
}

async function crearCarpeta(parentId: string, nombre: string): Promise<string> {
  const r = await drive().files.create({
    requestBody: { name: nombre, parents: [parentId], mimeType: FOLDER_MIME },
    ...ALL_DRIVES,
    fields: 'id',
  });
  return r.data.id as string;
}

export interface CarpetaCasoAsegurada {
  folderId: string;
  folderName: string;
  creada: boolean;              // false = ya existía y se reutilizó
  subcarpetasCreadas: string[];
}

/**
 * Deja lista la carpeta de una solicitud en DOCUMENTOS CLIENTES y le agrega la
 * subcarpeta de cada proceso que le falte. Idempotente: correrla otra vez no
 * duplica nada.
 *
 * Si la solicitud ya tiene carpeta (de cualquier mes, o con el nombre viejo) se
 * reutiliza en vez de crear otra: es una sola carpeta para todos los procesos de
 * la solicitud, y además una segunda carpeta haría que `resolverCarpetaCaso`
 * eligiera entre las dos al guardar el estado de cuenta o el poder. Se busca con
 * esa misma función para que ambos lados coincidan siempre en cuál es "la" carpeta.
 */
export async function asegurarCarpetaCaso(
  solicitud: string,
  procesos: ProcesoLibertador[],
): Promise<CarpetaCasoAsegurada> {
  const casosId = await carpetaLibertador(CARPETA_CASOS);
  if (!casosId) throw new Error(`No encontré DEMANDAS/LIBERTADOR/${CARPETA_CASOS} en el Drive.`);
  const sol = String(solicitud).trim();
  if (!sol) throw new Error('Solicitud vacía.');

  let carpeta = await buscarCarpetaCaso(casosId, sol);
  const creada = !carpeta;
  if (!carpeta) {
    const nombre = nombreCarpetaCaso(sol);
    carpeta = { folderId: await crearCarpeta(casosId, nombre), folderName: nombre };
  }

  const hijas = await listar(
    `'${carpeta.folderId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    'files(id,name)',
  );
  const existentes = new Set(hijas.map((f) => sinTildes(f.name || '')));
  const subcarpetasCreadas: string[] = [];
  for (const p of procesos) {
    if (existentes.has(p)) continue;
    await crearCarpeta(carpeta.folderId, p);
    existentes.add(p);
    subcarpetasCreadas.push(p);
  }
  return { ...carpeta, creada, subcarpetasCreadas };
}

// Descarga (o exporta) un archivo de Drive a Buffer.
async function bajarArchivo(f: drive_v3.Schema$File): Promise<Buffer> {
  if (f.mimeType === GDOC) {
    const r = await drive().files.export({ fileId: f.id as string, mimeType: DOCX_MIME }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data as ArrayBuffer);
  }
  const r = await drive().files.get(
    { fileId: f.id as string, alt: 'media', ...ALL_DRIVES },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(r.data as ArrayBuffer);
}

/**
 * Encuentra y baja la DECLARACION DE PAGOS de la carpeta del caso.
 * Excluye otras "declaraciones" (p. ej. "DECLARACIÓN GOMEZ..."). Prefiere .docx.
 */
export async function bajarDeclaracionPagos(
  folderId: string,
): Promise<{ buffer: Buffer; name: string } | null> {
  const items = await listar(`'${folderId}' in parents and trashed=false`);
  const decls = items.filter((f) => /declaraci.*pago/i.test(f.name || '') && f.mimeType !== FOLDER_MIME && f.mimeType !== GSHEET);
  if (!decls.length) return null;
  decls.sort((a, b) => (/\.docx$/i.test(b.name || '') || b.mimeType === GDOC ? 1 : 0)
    - (/\.docx$/i.test(a.name || '') || a.mimeType === GDOC ? 1 : 0));
  const f = decls[0];
  return { buffer: await bajarArchivo(f), name: f.name as string };
}

/** Baja la plantilla PODER DE CONCILIACION desde LIBERTADOR/CREAR PODERES (recursivo). */
export async function bajarPlantillaConciliacion(): Promise<Buffer | null> {
  const crearPoderesId = await carpetaLibertador('CREAR PODERES');
  if (!crearPoderesId) return null;

  const buscar = async (folderId: string): Promise<drive_v3.Schema$File | null> => {
    const items = await listar(`'${folderId}' in parents and trashed=false`);
    for (const f of items) {
      if (/plantilla poder de concili/i.test(f.name || '') && f.mimeType !== FOLDER_MIME) return f;
    }
    for (const f of items) {
      if (f.mimeType === FOLDER_MIME) { const hit = await buscar(f.id as string); if (hit) return hit; }
    }
    return null;
  };
  const f = await buscar(crearPoderesId);
  return f ? bajarArchivo(f) : null;
}

/** Sube (crea o reemplaza) el poder .docx dentro de la carpeta del caso. */
export async function subirPoder(folderId: string, nombre: string, buffer: Buffer): Promise<string> {
  const { Readable } = await import('stream');
  const media = { mimeType: DOCX_MIME, body: Readable.from(buffer) };

  const existentes = await listar(
    `'${folderId}' in parents and name='${nombre.replace(/'/g, "\\'")}' and trashed=false`,
    'files(id,name)',
  );
  if (existentes.length) {
    const r = await drive().files.update({ fileId: existentes[0].id as string, media, ...ALL_DRIVES, fields: 'id' });
    return r.data.id as string;
  }
  const r = await drive().files.create({
    requestBody: { name: nombre, parents: [folderId], mimeType: DOCX_MIME },
    media,
    ...ALL_DRIVES,
    fields: 'id',
  });
  return r.data.id as string;
}

/**
 * Plantilla EN BLANCO del estado de cuenta: LIBERTADOR/PLANTILLAS/ESTADO DE
 * CUENTA IA.xls. Se busca la "IA" a propósito: al lado está "ESTADO DE CUENTA.xls",
 * que es una copia diligenciada y arrastraría los datos de otro caso.
 */
export async function bajarPlantillaEstadoCuenta(): Promise<Buffer | null> {
  const plantillasId = await carpetaLibertador('PLANTILLAS');
  if (!plantillasId) return null;
  const items = await listar(`'${plantillasId}' in parents and trashed=false`);
  const f = items.find((x) => /estado de cuenta ia/i.test(x.name || '') && x.mimeType !== FOLDER_MIME);
  return f ? bajarArchivo(f) : null;
}

/** Sube (o reemplaza) un archivo de hoja de cálculo en la carpeta de un caso. */
export async function subirArchivoCaso(folderId: string, nombre: string, buffer: Buffer): Promise<string> {
  const { Readable } = await import('stream');
  const media = { mimeType: XLSX_MIME, body: Readable.from(buffer) };

  const existentes = await listar(
    `'${folderId}' in parents and name='${nombre.replace(/'/g, "\'")}' and trashed=false`,
    'files(id,name)',
  );
  if (existentes.length) {
    const r = await drive().files.update({ fileId: existentes[0].id as string, media, ...ALL_DRIVES, fields: 'id' });
    return r.data.id as string;
  }
  const r = await drive().files.create({
    requestBody: { name: nombre, parents: [folderId], mimeType: XLSX_MIME },
    media,
    ...ALL_DRIVES,
    fields: 'id',
  });
  return r.data.id as string;
}
