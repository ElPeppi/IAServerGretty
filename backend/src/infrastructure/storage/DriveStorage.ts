/**
 * DriveStorage — almacenamiento en Google Drive (Mi unidad de una cuenta del
 * Workspace) vía API, con DELEGACIÓN DE DOMINIO.
 *
 * Auth: service account (JWT) que SUPLANTA a una cuenta del dominio
 * (`DRIVE_IMPERSONATE_USER`, p. ej. servidor@jramosabogados.com), que es MIEMBRO
 * de la Unidad Compartida. El super-admin autoriza el Client ID del SA en la
 * Consola de Admin (Controles de API → Delegación de todo el dominio) con el scope
 * `drive`. Así el backend actúa COMO esa cuenta y escribe en la Unidad Compartida
 * (dueño = la unidad/organización, cuota del Workspace).
 *
 * Destino: `DRIVE_SHARED_DRIVE_ID` (Unidad Compartida) + `DRIVE_ROOT_FOLDER_ID`
 * (carpeta dedicada dentro de la unidad). Si no hay SHARED_DRIVE_ID, cae a "Mi
 * unidad" del usuario suplantado (modo dev).
 *
 * Modo OAuth (pruebas con cuenta PERSONAL Gmail): DRIVE_AUTH=oauth. Sin Workspace no
 * hay delegación ni Unidad Compartida; se usa OAuth (cliente de escritorio + refresh
 * token) y se escribe en "Mi unidad" de la cuenta autorizada.
 *
 * Env:
 *   DRIVE_AUTH             'delegation' (default) | 'oauth'
 *   DRIVE_SA_KEY           [delegation] ruta al JSON del service account
 *   DRIVE_IMPERSONATE_USER [delegation] correo de la cuenta a suplantar (miembro de la unidad)
 *   DRIVE_SHARED_DRIVE_ID  [delegation] ID de la Unidad Compartida
 *   DRIVE_OAUTH_CRED       [oauth] ruta al oauth-credentials.json (App de escritorio)
 *   DRIVE_OAUTH_TOKEN      [oauth] ruta al token.json (con refresh token)
 *   DRIVE_ROOT_FOLDER_ID   carpeta raíz donde crear las {cedula}/... (default: la unidad / 'root')
 *
 * Índice relPath→fileId: tabla Prisma `DriveFile` (persistente).
 *
 * STORAGE_DRIVER=drive → esta implementación.
 */
import fs from 'fs';
import { google, drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { Readable } from 'stream';
import { IStorage, StorageObject, ArchivoRemoto } from './IStorage';
import { prisma } from '../database/prisma/client';

// Modo de autenticación:
//   'delegation' (default) → service account + delegación de dominio (Workspace, prod).
//   'oauth'                → OAuth de una cuenta personal (Gmail, para pruebas).
const DRIVE_AUTH = (process.env.DRIVE_AUTH || 'delegation').toLowerCase();
const SA_KEY = process.env.DRIVE_SA_KEY || '';
const IMPERSONATE_USER = process.env.DRIVE_IMPERSONATE_USER || '';
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || '';
// OAuth (cuenta personal): JSON del OAuth client "App de escritorio" + token con refresh.
const OAUTH_CRED = process.env.DRIVE_OAUTH_CRED || '';
const OAUTH_TOKEN = process.env.DRIVE_OAUTH_TOKEN || '';
// Raíz donde el backend crea las {cedula}/...: carpeta dedicada, o la unidad, o Mi unidad.
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || SHARED_DRIVE_ID || 'root';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Parámetros extra para acotar las búsquedas a la Unidad Compartida (si aplica).
// En "Mi unidad" (sin SHARED_DRIVE_ID) se omiten y busca en el espacio del usuario.
const DRIVE_SCOPE = SHARED_DRIVE_ID
  ? { corpora: 'drive' as const, driveId: SHARED_DRIVE_ID }
  : {};

function baseUrl(): string {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

export class DriveStorage implements IStorage {
  private _drive: drive_v3.Drive | null = null;

  // ── Índice relPath→fileId (tabla Prisma DriveFile) ───────────────────────────
  // Persistente: sobrevive reinicios y evita resolver el fileId por API cada vez.
  private async idxGet(relPath: string): Promise<string | null> {
    const row = await prisma.driveFile.findUnique({ where: { relPath } });
    return row?.fileId ?? null;
  }
  private async idxSet(relPath: string, fileId: string): Promise<void> {
    await prisma.driveFile.upsert({
      where: { relPath },
      create: { relPath, fileId },
      update: { fileId },
    });
  }
  private async idxDel(relPath: string): Promise<void> {
    await prisma.driveFile.deleteMany({ where: { relPath } });
  }

  /** Cliente Drive perezoso: no autentica hasta el primer uso real. */
  private get drive(): drive_v3.Drive {
    if (!this._drive) {
      const auth: OAuth2Client = DRIVE_AUTH === 'oauth'
        ? this.oauthClient()
        : new google.auth.JWT({
            keyFile: SA_KEY,
            scopes: ['https://www.googleapis.com/auth/drive'],
            subject: IMPERSONATE_USER, // delegación de dominio: actúa COMO esta cuenta
          });
      this._drive = google.drive({ version: 'v3', auth });
    }
    return this._drive;
  }

  /** Cliente OAuth2 de una cuenta personal (Gmail): cliente de escritorio + refresh token. */
  private oauthClient(): OAuth2Client {
    const raw = JSON.parse(fs.readFileSync(OAUTH_CRED, 'utf8'));
    const cfg = raw.installed || raw.web;
    if (!cfg?.client_id) throw new Error(`${OAUTH_CRED} no es un OAuth client de "App de escritorio" válido.`);
    const oauth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
    oauth.setCredentials(JSON.parse(fs.readFileSync(OAUTH_TOKEN, 'utf8')));
    // Persiste el token si googleapis lo refresca (para no re-autorizar).
    oauth.on('tokens', (t) => {
      try {
        const cur = JSON.parse(fs.readFileSync(OAUTH_TOKEN, 'utf8'));
        fs.writeFileSync(OAUTH_TOKEN, JSON.stringify({ ...cur, ...t }, null, 2));
      } catch { /* best-effort */ }
    });
    return oauth;
  }

  get enabled(): boolean {
    if (DRIVE_AUTH === 'oauth') return !!(OAUTH_CRED && OAUTH_TOKEN);
    // Basta con poder suplantar y saber DÓNDE escribir: la unidad compartida, o
    // una carpeta concreta (la data de la oficina vive en "Mi unidad" de servidor@;
    // la Unidad Compartida solo tiene un ACCESO DIRECTO a ella).
    return !!(SA_KEY && IMPERSONATE_USER && (SHARED_DRIVE_ID || ROOT_FOLDER_ID !== 'root'));
  }

  urlFor(relPath: string): string {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return `${baseUrl()}/docs/${encoded}`;
  }

  relPathFromUrl(url: string): string | null {
    const marker = '/docs/';
    const i = url.indexOf(marker);
    if (i < 0) return null;
    return decodeURIComponent(url.slice(i + marker.length)).replace(/^\/+/, '');
  }

  // ── Resolución de carpetas/archivos ──────────────────────────────────────────

  /**
   * Busca un hijo por nombre dentro de un parent. Devuelve fileId o null.
   * Sigue los ACCESOS DIRECTOS (shortcuts): en la unidad compartida la carpeta
   * "05 DOCUMENTOS ACTUALIZADOS 2019" es un shortcut a la carpeta real, y el
   * árbol puede tener más. Se filtra carpeta/archivo en código (no en la query)
   * porque el mimeType del shortcut no es el del destino.
   */
  private async findChild(parentId: string, name: string, folder: boolean): Promise<string | null> {
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
      'trashed = false',
    ].join(' and ');
    const res = await this.drive.files.list({
      q,
      fields: 'files(id,name,mimeType,shortcutDetails(targetId,targetMimeType))',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      ...DRIVE_SCOPE,
    });
    for (const f of res.data.files ?? []) {
      const sc = f.shortcutDetails;
      const id = sc?.targetId ?? f.id;
      const mime = sc?.targetMimeType ?? f.mimeType;
      if (!id) continue;
      if (folder === (mime === FOLDER_MIME)) return id;
    }
    return null;
  }

  /** Crea (o devuelve) una carpeta hija. */
  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const existing = await this.findChild(parentId, name, true);
    if (existing) return existing;
    const res = await this.drive.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: 'id',
      supportsAllDrives: true,
    });
    return res.data.id!;
  }

  /** Recorre los segmentos de carpeta de un dir relativo → fileId de la carpeta (o null). */
  private async resolveFolder(relDir: string, createFolders: boolean): Promise<string | null> {
    const parts = String(relDir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let parentId = ROOT_FOLDER_ID;
    for (const seg of parts) {
      const child = createFolders
        ? await this.ensureFolder(parentId, seg)
        : await this.findChild(parentId, seg, true);
      if (!child) return null;
      parentId = child;
    }
    return parentId;
  }

  /**
   * relPath → { parentId, name, fileId? }. Crea las carpetas intermedias si createFolders.
   */
  private async resolve(relPath: string, createFolders: boolean): Promise<{ parentId: string; name: string; fileId: string | null }> {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = clean.split('/');
    const name = parts.pop()!;
    const dir = parts.join('/');
    const parentId = await this.resolveFolder(dir, createFolders);
    if (!parentId) throw new Error(`Carpeta no encontrada para: ${relPath}`);
    const cached = await this.idxGet(clean);
    const fileId = cached ?? (await this.findChild(parentId, name, false));
    if (fileId && !cached) await this.idxSet(clean, fileId);
    return { parentId, name, fileId };
  }

  // ── IStorage ─────────────────────────────────────────────────────────────────

  async save(relPath: string, data: Buffer, mime = 'application/octet-stream'): Promise<StorageObject> {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const { parentId, name, fileId } = await this.resolve(clean, true);
    const media = { mimeType: mime, body: bufferToStream(data) };

    const crear = async (): Promise<void> => {
      const res = await this.drive.files.create({
        requestBody: { name, parents: [parentId] },
        media,
        fields: 'id',
        supportsAllDrives: true,
      });
      await this.idxSet(clean, res.data.id!);
    };

    if (fileId) {
      try {
        // `trashed: false` REVIVE el archivo si estaba en la papelera. El fileId
        // puede venir del índice, que no sabe si alguien lo borró a mano en Drive:
        // sin esto el update escribe sobre el archivo borrado y el usuario nunca
        // lo ve reaparecer (ni en la UI ni en `list`, que filtran trashed).
        // Se piden los `parents` en la MISMA respuesta para comprobar de paso que
        // el archivo siga colgando de la carpeta correcta.
        const res = await this.drive.files.update({
          fileId,
          media,
          requestBody: { trashed: false },
          fields: 'id,parents',
          supportsAllDrives: true,
        });

        // Quitar un archivo de una carpeta en Drive NO lo borra: lo deja huérfano
        // en la raíz ("Mi unidad"). Como el índice conserva su fileId, el update
        // de arriba escribiría el contenido nuevo en ese archivo suelto y en la
        // carpeta del cliente no aparecería nada. Si el padre no es el que toca,
        // se devuelve a su sitio.
        const padres = res.data.parents ?? [];
        if (padres.length && !padres.includes(parentId)) {
          await this.drive.files.update({
            fileId,
            addParents: parentId,
            removeParents: padres.join(','),
            fields: 'id',
            supportsAllDrives: true,
          });
          console.error(`[DriveStorage] "${clean}" estaba fuera de su carpeta → devuelto a su sitio`);
        }
      } catch (e) {
        // Borrado DEFINITIVO (vaciaron la papelera) → el fileId ya no existe:
        // se descarta del índice y se crea de nuevo.
        const status = (e as { code?: number; status?: number })?.code ?? (e as { status?: number })?.status;
        if (status !== 404) throw e;
        await this.idxDel(clean);
        await crear();
      }
    } else {
      await crear();
    }
    return { relPath: clean, url: this.urlFor(clean) };
  }

  async overwrite(relPath: string, data: Buffer): Promise<void> {
    const { fileId } = await this.resolve(relPath, false);
    if (!fileId) throw new Error('El archivo no existe en Drive');
    await this.drive.files.update({
      fileId,
      media: { body: bufferToStream(data) },
      supportsAllDrives: true,
    });
  }

  async read(relPath: string): Promise<Buffer> {
    const s = await this.stream(relPath);
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      s.on('data', (c) => chunks.push(c as Buffer));
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });
  }

  async stream(relPath: string): Promise<NodeJS.ReadableStream> {
    const { fileId } = await this.resolve(relPath, false);
    if (!fileId) throw new Error('El archivo no existe en Drive');
    const res = await this.drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    return res.data as unknown as NodeJS.ReadableStream;
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      const { fileId } = await this.resolve(relPath, false);
      return !!fileId;
    } catch {
      return false;
    }
  }

  async list(relDir: string): Promise<string[]> {
    const folderId = await this.resolveFolder(relDir, false);
    if (!folderId) return [];
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(name)',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 1000,
        pageToken,
        ...DRIVE_SCOPE,
      });
      for (const f of res.data.files ?? []) if (f.name) names.push(f.name);
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return names;
  }

  async listDetallado(relDir: string): Promise<ArchivoRemoto[]> {
    const folderId = await this.resolveFolder(relDir, false);
    if (!folderId) return [];
    const out: ArchivoRemoto[] = [];
    const atajos: Array<{ nombre: string; targetId: string }> = [];
    let pageToken: string | undefined;

    do {
      const res = await this.drive.files.list({
        // Se excluyen las carpetas aquí y no después: así el pageSize cuenta
        // archivos de verdad en directorios con muchas subcarpetas (GARANTIAS).
        q: `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
        fields: 'nextPageToken, files(id,name,mimeType,md5Checksum,size,shortcutDetails(targetId,targetMimeType))',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 1000,
        pageToken,
        ...DRIVE_SCOPE,
      });
      for (const f of res.data.files ?? []) {
        if (!f.name) continue;
        const sc = f.shortcutDetails;
        if (sc?.targetId) {
          // Un ACCESO DIRECTO no trae el md5 del destino (ni siquiera dice si el
          // destino es carpeta en el filtro de arriba). Se resuelve aparte.
          if (sc.targetMimeType !== FOLDER_MIME) atajos.push({ nombre: f.name, targetId: sc.targetId });
          continue;
        }
        // md5Checksum no viene en los formatos nativos de Google (Docs, Sheets):
        // esos no son insumos válidos y el sincronizador los descarta por eso.
        out.push({ nombre: f.name, md5: f.md5Checksum ?? null, tamano: Number(f.size ?? 0) });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Normalmente `atajos` viene vacío y esto no cuesta nada.
    for (const a of atajos) {
      try {
        const { data } = await this.drive.files.get({
          fileId: a.targetId,
          fields: 'name,md5Checksum,size',
          supportsAllDrives: true,
        });
        // Se conserva el nombre del ACCESO DIRECTO: es el que ve la oficina en
        // esa carpeta, y con el que se guardará en el servidor.
        out.push({ nombre: a.nombre, md5: data.md5Checksum ?? null, tamano: Number(data.size ?? 0) });
      } catch {
        // Destino borrado o sin permiso: se ignora, como si no estuviera.
      }
    }
    return out;
  }

  async delete(relPath: string): Promise<void> {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const { fileId } = await this.resolve(clean, false);
    if (fileId) {
      await this.drive.files.delete({ fileId, supportsAllDrives: true });
      await this.idxDel(clean);
    }
  }
}
