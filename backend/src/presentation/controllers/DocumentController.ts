import { Response } from 'express';
import { GetDocumentsUseCase } from '../../application/use-cases/documents/GetDocumentsUseCase';
import { GetDocumentByIdUseCase } from '../../application/use-cases/documents/GetDocumentByIdUseCase';
import { SignDocumentUseCase } from '../../application/use-cases/documents/SignDocumentUseCase';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { NasStorage } from '../../infrastructure/services/NasStorage';
import { AuthRequest } from '../middlewares/authMiddleware';
import { DocumentStatus } from '../../domain/entities/Document';

const nas = new NasStorage();

const documentRepository = new PrismaDocumentRepository();
const userRepository = new PrismaUserRepository();

const getDocumentsUseCase = new GetDocumentsUseCase(documentRepository);
const getDocumentByIdUseCase = new GetDocumentByIdUseCase(documentRepository);
const signDocumentUseCase = new SignDocumentUseCase(documentRepository, userRepository);

export class DocumentController {
  async getAll(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { status, from, to, search, page, pageSize } = req.query;

      const p  = parseInt(page as string, 10);
      const ps = parseInt(pageSize as string, 10);
      const pageNum = Number.isFinite(p) && p > 0 ? p : 1;
      const sizeNum = Number.isFinite(ps) && ps > 0 ? Math.min(100, ps) : 24;

      const { items, total } = await getDocumentsUseCase.execute({
        // La oficina trabaja en común: todos los usuarios (ADMIN y LAWYER) ven
        // TODAS las demandas, no solo las que generó cada uno.
        lawyerId: undefined,
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
      // Todos los usuarios (ADMIN/LAWYER) pueden ver cualquier demanda.
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
      // Trabajo colaborativo: cualquier usuario puede editar (salvo firmadas).
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

  /**
   * Sobreescribe el .xlsx/.xls de ASIGNACIÓN en el NAS con la versión editada
   * desde la web (editor de tabla en la pestaña "Asignación"). OJO: la asignación
   * es el Excel del LOTE completo, compartido por todas las demandas de esa
   * asignación; editarlo afecta a todas. No depende del estado de firma de la
   * demanda (es dato de origen, no el documento firmado).
   */
  async saveAsignacion(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const file = (req as AuthRequest & { file?: { buffer: Buffer } }).file;
      if (!file) {
        res.status(400).json({ message: 'Archivo requerido (campo: file)' });
        return;
      }

      const document = await getDocumentByIdUseCase.execute(id);
      if (!nas.enabled) {
        res.status(503).json({ message: 'DOCS_DIR no está configurado: no se puede sobreescribir en el NAS' });
        return;
      }
      if (!document.asignacionUrl) {
        res.status(400).json({ message: 'Esta demanda no tiene un Excel de asignación asociado' });
        return;
      }
      const rel = nas.relPathFromUrl(document.asignacionUrl);
      if (!rel) {
        res.status(400).json({ message: 'No se pudo determinar la ruta de la asignación en el NAS' });
        return;
      }
      if (!/\.xlsx?$/i.test(rel)) {
        res.status(400).json({ message: 'La asignación no es un archivo Excel (.xlsx/.xls)' });
        return;
      }

      nas.overwrite(rel, file.buffer);
      res.json({ success: true, message: 'Asignación sobrescrita en el NAS', asignacionUrl: document.asignacionUrl });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al guardar la asignación';
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
