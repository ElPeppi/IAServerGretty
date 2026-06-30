/**
 * NasStorage — sirve y sobreescribe los documentos directamente desde el NAS.
 *
 * El MOTOR (sac_scripts) escribe todo en `SAC_OUT_DIR/{cedula}/...` (la carpeta
 * de la NAS). El backend NO copia esos archivos a su disco ni a S3: los referencia
 * por su ruta relativa y los publica en `/docs` (express.static(DOCS_DIR)).
 *
 *   DOCS_DIR (backend) DEBE apuntar a la MISMA carpeta que SAC_OUT_DIR (motor).
 *   En producción ambos usan por defecto la NAS (…/GARANTIAS). En local, si el
 *   motor escribe en C:/SAC_Documentos, pon DOCS_DIR=C:/SAC_Documentos.
 *
 * Así no se usa ni S3 ni el almacenamiento del servidor: la fuente única es el NAS.
 */
import fs from 'fs';
import path from 'path';

const DOCS_DIR = process.env.DOCS_DIR || '';

function baseUrl(): string {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

export class NasStorage {
  /** ¿Está configurado el NAS (DOCS_DIR)? */
  get enabled(): boolean {
    return !!DOCS_DIR;
  }

  get root(): string {
    return DOCS_DIR;
  }

  /** Ruta relativa (posix) → URL pública servida por /docs. */
  urlForRelPath(rel: string): string {
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return `${baseUrl()}/docs/${encoded}`;
  }

  /** URL pública (o fileUrl guardada) → ruta relativa dentro del NAS. */
  relPathFromUrl(url: string): string | null {
    const marker = '/docs/';
    const i = url.indexOf(marker);
    if (i < 0) return null;
    return decodeURIComponent(url.slice(i + marker.length)).replace(/^\/+/, '');
  }

  /** Resuelve una ruta relativa a una ABSOLUTA dentro del NAS (evita path traversal). */
  absFromRelPath(rel: string): string {
    if (!DOCS_DIR) throw new Error('DOCS_DIR no está configurado en el backend');
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const root = path.resolve(DOCS_DIR);
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('Ruta fuera del directorio del NAS');
    }
    return abs;
  }

  /** Escribe un archivo nuevo en el NAS y devuelve su URL pública. */
  saveBuffer(buffer: Buffer, rel: string): string {
    const abs = this.absFromRelPath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    return this.urlForRelPath(rel);
  }

  /** Sobreescribe un archivo EXISTENTE del NAS (usado por el editor de la demanda). */
  overwrite(rel: string, buffer: Buffer): void {
    const abs = this.absFromRelPath(rel);
    if (!fs.existsSync(abs)) throw new Error('El archivo no existe en el NAS');
    fs.writeFileSync(abs, buffer);
  }
}
