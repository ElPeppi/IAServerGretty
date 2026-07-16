/**
 * DriveStorage — almacenamiento en Google Drive (Shared Drive) vía API.
 *
 * ESQUELETO (sin cablear, con TODOs). Destino:
 *   backend/src/infrastructure/storage/DriveStorage.ts
 *
 * Requisitos al implementar:
 *   - npm i googleapis
 *   - Service account MIEMBRO de la Shared Drive (rol "Administrador de contenido")
 *     → NO hace falta domain-wide delegation.
 *   - Env: DRIVE_SA_KEY (ruta al JSON del service account),
 *          DRIVE_SHARED_DRIVE_ID, DRIVE_ROOT_FOLDER_ID (carpeta raíz dentro de la unidad).
 *   - Índice relPath↔fileId en Postgres (modelo Prisma DriveFile) para no resolver
 *     por query cada vez (lento + cuota). Aquí se usa un Map en memoria como placeholder.
 *
 * NOTA: importa 'googleapis', que aún no está instalado; por eso este archivo vive en
 * docs/ (fuera de backend/src) y no entra al build hasta que se mueva y se instale.
 */
import fs from 'fs';
import { google, drive_v3 } from 'googleapis';
import { IStorage, StorageObject } from './IStorage';

const SA_KEY = process.env.DRIVE_SA_KEY || '';
const SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || '';
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || SHARED_DRIVE_ID;

function baseUrl(): string {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveStorage implements IStorage {
  private drive: drive_v3.Drive;
  /** Índice relPath→fileId. TODO: reemplazar por tabla Prisma DriveFile. */
  private idx = new Map<string, string>();

  constructor() {
    const auth = new google.auth.JWT({
      keyFile: SA_KEY,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
  }

  get enabled(): boolean {
    return !!(SA_KEY && SHARED_DRIVE_ID);
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
      corpora: 'drive',
      driveId: SHARED_DRIVE_ID,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
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

  /**
   * relPath → { parentId, name, fileId? }. Crea las carpetas intermedias si faltan.
   * TODO: cachear en el índice Prisma; aquí solo Map en memoria.
   */
  private async resolve(relPath: string, createFolders: boolean): Promise<{ parentId: string; name: string; fileId: string | null }> {
    const parts = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    const name = parts.pop()!;
    let parentId = ROOT_FOLDER_ID;
    for (const seg of parts) {
      const child = createFolders
        ? await this.ensureFolder(parentId, seg)
        : await this.findChild(parentId, seg, true);
      if (!child) throw new Error(`Carpeta no encontrada: ${seg}`);
      parentId = child;
    }
    const fileId = this.idx.get(relPath) ?? (await this.findChild(parentId, name, false));
    if (fileId) this.idx.set(relPath, fileId);
    return { parentId, name, fileId };
  }

  // ── IStorage ─────────────────────────────────────────────────────────────────

  async save(relPath: string, data: Buffer, mime = 'application/octet-stream'): Promise<StorageObject> {
    const { parentId, name, fileId } = await this.resolve(relPath, true);
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
      this.idx.set(relPath, res.data.id!);
    }
    return { relPath, url: this.urlFor(relPath) };
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

  async delete(relPath: string): Promise<void> {
    const { fileId } = await this.resolve(relPath, false);
    if (fileId) {
      await this.drive.files.delete({ fileId, supportsAllDrives: true });
      this.idx.delete(relPath);
    }
  }
}

// Buffer → stream (googleapis media.body espera un Readable).
function bufferToStream(buf: Buffer): NodeJS.ReadableStream {
  const { Readable } = require('stream');
  return Readable.from(buf);
}
