/**
 * FileStorage — persiste archivos generados y devuelve su URL pública.
 *
 * Hoy guarda en la carpeta local `uploads/` (servida en `/uploads`). Para migrar
 * a Amazon S3 más adelante basta cambiar esta clase; el resto del backend no se
 * entera (solo recibe la URL).
 */
import fs from 'fs';
import path from 'path';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

function baseUrl(): string {
  return process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

export interface StoredFile {
  url: string;
  filename: string;
  mimeType: string;
}

export class FileStorage {
  private ensureDir(): void {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  saveBuffer(buffer: Buffer, filename: string, mimeType = 'application/octet-stream'): StoredFile {
    this.ensureDir();
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, safe), buffer);
    return { url: `${baseUrl()}/uploads/${safe}`, filename: safe, mimeType };
  }

  saveBase64(content: string, filename: string, mimeType = 'application/octet-stream'): StoredFile {
    return this.saveBuffer(Buffer.from(content, 'base64'), filename, mimeType);
  }
}
