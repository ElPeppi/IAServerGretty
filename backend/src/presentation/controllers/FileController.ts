import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export class FileController {
  // Called by n8n to store a generated/signed file
  async upload(req: Request, res: Response): Promise<void> {
    try {
      const { content, filename, mimeType } = req.body as {
        content: string;
        filename: string;
        mimeType?: string;
      };

      if (!content || !filename) {
        res.status(400).json({ message: 'content y filename son requeridos' });
        return;
      }

      ensureUploadsDir();

      const safeFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filePath = path.join(UPLOADS_DIR, safeFilename);
      const buffer = Buffer.from(content, 'base64');
      fs.writeFileSync(filePath, buffer);

      const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
      const url = `${baseUrl}/uploads/${safeFilename}`;

      res.json({ url, filename: safeFilename, mimeType: mimeType ?? 'application/octet-stream' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error interno';
      res.status(500).json({ message });
    }
  }
}
