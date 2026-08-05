/**
 * DocsController — sirve los documentos (demanda/anexos/antecedentes/asignación)
 * por `/docs/{relPath}` haciendo STREAMING desde el `storage` configurado
 * (FsStorage=disco/NAS o DriveStorage=Google Drive).
 *
 * Reemplaza al viejo `express.static(DOCS_DIR)`: así la misma URL funciona tanto
 * en NAS como en Drive (en Drive no hay ruta de disco, se baja por la API).
 *
 * Acceso PÚBLICO, igual que antes: estas URLs las consume el navegador
 * directamente (`<iframe src>`, `<a href target=_blank>`, el editor SuperDoc y el
 * visor de xlsx) SIN mandar el token JWT. Meter `requireAuth` aquí rompería esas
 * cargas. La autorización por usuario queda como mejora aparte (exige que el
 * frontend haga fetch con token y arme un blob URL).
 */
import { Request, Response } from 'express';
import path from 'path';
import { storage } from '../../infrastructure/storage';

// Content-Type por extensión (los tipos que produce el sistema).
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export class DocsController {
  // Montado con `app.use('/docs', ...)`: `req.path` es la ruta DESPUÉS de /docs
  // (p. ej. "/123456/DEMANDA%20FIRMADA.pdf"). Se decodifica y normaliza a posix.
  async serve(req: Request, res: Response): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    if (!storage.enabled) {
      // Sin storage configurado: como cuando la ruta no existía → 404.
      res.status(404).end();
      return;
    }

    let relPath: string;
    try {
      relPath = decodeURIComponent(req.path).replace(/\\/g, '/').replace(/^\/+/, '');
    } catch {
      // URL mal codificada.
      res.status(400).end();
      return;
    }
    if (!relPath) {
      res.status(404).end();
      return;
    }

    try {
      // storage.exists/stream resuelven la ruta y protegen contra path traversal
      // (FsStorage valida que no escape de DOCS_DIR; DriveStorage no encuentra el "..").
      if (!(await storage.exists(relPath))) {
        res.status(404).end();
        return;
      }

      const ext = path.posix.extname(relPath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      // Inline para previsualizar (PDF/imagen en iframe); filename para descargas.
      const base = path.posix.basename(relPath);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(base)}`);
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }

      const stream = await storage.stream(relPath);
      stream.on('error', (e) => {
        console.error('[docs] stream error:', relPath, e instanceof Error ? e.message : e);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      stream.pipe(res);
    } catch (e) {
      console.error('[docs] error:', relPath, e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(404).end();
    }
  }
}
