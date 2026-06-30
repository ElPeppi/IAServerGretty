import { Response } from 'express';
import { GetDocumentsUseCase } from '../../application/use-cases/documents/GetDocumentsUseCase';
import { GetDocumentByIdUseCase } from '../../application/use-cases/documents/GetDocumentByIdUseCase';
import { SignDocumentUseCase } from '../../application/use-cases/documents/SignDocumentUseCase';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { N8nService } from '../../infrastructure/services/N8nService';
import { NasStorage } from '../../infrastructure/services/NasStorage';
import { AuthRequest } from '../middlewares/authMiddleware';
import { DocumentStatus } from '../../domain/entities/Document';

const nas = new NasStorage();

const documentRepository = new PrismaDocumentRepository();
const userRepository = new PrismaUserRepository();
const n8nService = new N8nService();

const getDocumentsUseCase = new GetDocumentsUseCase(documentRepository);
const getDocumentByIdUseCase = new GetDocumentByIdUseCase(documentRepository);
const signDocumentUseCase = new SignDocumentUseCase(documentRepository, userRepository, n8nService);

export class DocumentController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { status, from, to, search, page, pageSize } = req.query;
      const isAdmin = req.user?.role === 'ADMIN';

      const p  = parseInt(page as string, 10);
      const ps = parseInt(pageSize as string, 10);
      const pageNum = Number.isFinite(p) && p > 0 ? p : 1;
      const sizeNum = Number.isFinite(ps) && ps > 0 ? Math.min(100, ps) : 24;

      const { items, total } = await getDocumentsUseCase.execute({
        lawyerId: isAdmin ? undefined : req.user?.userId,
        status: status as DocumentStatus | undefined,
        from: from ? new Date(from as string) : undefined,
        to: to ? new Date(to as string) : undefined,
        search: (search as string)?.trim() || undefined,
        page: pageNum,
        pageSize: sizeNum,
      });

      res.json({ items, total, page: pageNum, pageSize: sizeNum });
    } catch {
      res.status(500).json({ message: 'Error al obtener documentos' });
    }
  }

  async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const document = await getDocumentByIdUseCase.execute(id);
      const isOwner = document.lawyerId === req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';
      if (!isOwner && !isAdmin) {
        res.status(403).json({ message: 'Sin permiso para ver este documento' });
        return;
      }
      res.json(document);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error desconocido';
      res.status(404).json({ message });
    }
  }

  /**
   * Sobreescribe el .docx de la demanda en el NAS con la versión editada desde la
   * web (editor SuperDoc). No copia a S3 ni al disco del servidor: edita el archivo
   * original. Permitido al dueño de la demanda o a un ADMIN (no a demandas firmadas).
   */
  async saveFile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const file = (req as AuthRequest & { file?: { buffer: Buffer } }).file;
      if (!file) {
        res.status(400).json({ message: 'Archivo requerido (campo: file)' });
        return;
      }

      const document = await getDocumentByIdUseCase.execute(id);
      const isOwner = document.lawyerId === req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';
      if (!isOwner && !isAdmin) {
        res.status(403).json({ message: 'Sin permiso para editar este documento' });
        return;
      }
      if (document.status === 'SIGNED') {
        res.status(409).json({ message: 'La demanda ya está firmada; no se puede modificar' });
        return;
      }
      if (!nas.enabled) {
        res.status(503).json({ message: 'DOCS_DIR no está configurado: no se puede sobreescribir en el NAS' });
        return;
      }

      const meta = (document.metadata ?? {}) as { demandaRelPath?: string };
      const rel = meta.demandaRelPath
        ?? (document.fileUrl ? nas.relPathFromUrl(document.fileUrl) : null);
      if (!rel) {
        res.status(400).json({ message: 'No se pudo determinar la ruta del archivo en el NAS' });
        return;
      }

      nas.overwrite(rel, file.buffer);
      res.json({ success: true, message: 'Archivo sobrescrito en el NAS', fileUrl: document.fileUrl });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al guardar el archivo';
      res.status(400).json({ message });
    }
  }

  async sign(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const document = await signDocumentUseCase.execute({
        documentId: id,
        lawyerId: req.user!.userId,
      });
      res.json(document);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al firmar';
      res.status(400).json({ message });
    }
  }
}
