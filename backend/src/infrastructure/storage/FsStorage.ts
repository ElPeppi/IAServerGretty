/**
 * FsStorage — almacenamiento en filesystem (la NAS de hoy).
 *
 * Es el `NasStorage` original adaptado a la interfaz `IStorage` (métodos async +
 * stream + list). DOCS_DIR = raíz (la MISMA carpeta que SAC_OUT_DIR del motor).
 * No copia a S3 ni al disco del servidor: la fuente es esa carpeta.
 *
 * STORAGE_DRIVER=nas (default) → esta implementación (comportamiento actual).
 */
import fs from 'fs';
import path from 'path';
import { IStorage, StorageObject } from './IStorage';

const DOCS_DIR = process.env.DOCS_DIR || '';

function baseUrl(): string {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

export class FsStorage implements IStorage {
  get enabled(): boolean {
    return !!DOCS_DIR;
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

  /** Resuelve relPath → ruta ABSOLUTA dentro del NAS (evita path traversal). */
  private abs(relPath: string): string {
    if (!DOCS_DIR) throw new Error('DOCS_DIR no está configurado');
    const clean = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const root = path.resolve(DOCS_DIR);
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('Ruta fuera del directorio del NAS');
    }
    return abs;
  }

  async save(relPath: string, data: Buffer, _mime?: string): Promise<StorageObject> {
    const abs = this.abs(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return { relPath, url: this.urlFor(relPath) };
  }

  async overwrite(relPath: string, data: Buffer): Promise<void> {
    const abs = this.abs(relPath);
    if (!fs.existsSync(abs)) throw new Error('El archivo no existe');
    fs.writeFileSync(abs, data);
  }

  async read(relPath: string): Promise<Buffer> {
    return fs.readFileSync(this.abs(relPath));
  }

  async stream(relPath: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.abs(relPath));
  }

  async exists(relPath: string): Promise<boolean> {
    try { return fs.existsSync(this.abs(relPath)); } catch { return false; }
  }

  async list(relDir: string): Promise<string[]> {
    try {
      const abs = this.abs(relDir);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
      return fs.readdirSync(abs);
    } catch {
      return [];
    }
  }

  async delete(relPath: string): Promise<void> {
    const abs = this.abs(relPath);
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }
}
