/**
 * libertadorDrive.ts — Acceso a Drive para el flujo de poderes de Libertador.
 *
 * Los casos de Libertador viven SOLO en el Drive de la oficina, bajo:
 *   <ROOT>/DEMANDAS/LIBERTADOR/SINGULAR/<solicitud>
 * y la plantilla del poder en:
 *   <ROOT>/DEMANDAS/LIBERTADOR/CREAR PODERES/.../PLANTILLA PODER DE CONCILIACION.docx
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

/**
 * Resuelve la carpeta del caso por número de solicitud dentro de LIBERTADOR/SINGULAR.
 * Las carpetas a veces traen sufijo de año ("5761466 - 2025"); se prefiere el match
 * exacto y, si hay varias por año, la de año más reciente.
 */
export async function resolverCarpetaCaso(
  solicitud: string,
): Promise<{ folderId: string; folderName: string } | null> {
  const singularId = await carpetaLibertador('SINGULAR');
  if (!singularId) return null;
  const sol = String(solicitud).trim();

  const items = await listar(
    `'${singularId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    'files(id,name)',
  );
  // Candidatas: nombre === solicitud, o empieza por la solicitud (p. ej. "<sol> - 2025").
  const cand = items.filter((f) => {
    const n = (f.name || '').trim();
    return n === sol || new RegExp(`^${sol}\\b`).test(n);
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
