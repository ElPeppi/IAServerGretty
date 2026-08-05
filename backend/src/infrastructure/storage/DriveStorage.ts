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
import { IStorage, StorageObject } from './IStorage';
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
    return !!(SA_KEY && IMPERSONATE_USER && SHARED_DRIVE_ID);
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

  /** Busca un hijo por nombre dentro de un parent. Devuelve fileId o null. */
  private async findChild(parentId: string, name: string, folder: boolean): Promise<string | null> {
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
      `mimeType ${folder ? '=' : '!='} '${FOLDER_MIME}'`,
      'trashed = false',
    ].join(' and ');
    const res = await this.drive.files.list({
      q,
      fields: 'files(id,name)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      ...DRIVE_SCOPE,
    });
    return res.data.files?.[0]?.id ?? null;
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
    if (fileId) {
      await this.drive.files.update({ fileId, media, supportsAllDrives: true });
    } else {
      const res = await this.drive.files.create({
        requestBody: { name, parents: [parentId] },
        media,
        fields: 'id',
        supportsAllDrives: true,
      });
      await this.idxSet(clean, res.data.id!);
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

  async delete(relPath: string): Promise<void> {
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const { fileId } = await this.resolve(clean, false);
    if (fileId) {
      await this.drive.files.delete({ fileId, supportsAllDrives: true });
      await this.idxDel(clean);
    }
  }
}
