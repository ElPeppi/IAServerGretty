"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentController = void 0;
const GetDocumentsUseCase_1 = require("../../application/use-cases/documents/GetDocumentsUseCase");
const GetDocumentByIdUseCase_1 = require("../../application/use-cases/documents/GetDocumentByIdUseCase");
const SignDocumentUseCase_1 = require("../../application/use-cases/documents/SignDocumentUseCase");
const DocumentRepository_1 = require("../../infrastructure/database/prisma/DocumentRepository");
const UserRepository_1 = require("../../infrastructure/database/prisma/UserRepository");
const NasStorage_1 = require("../../infrastructure/services/NasStorage");
const nas = new NasStorage_1.NasStorage();
const documentRepository = new DocumentRepository_1.PrismaDocumentRepository();
const userRepository = new UserRepository_1.PrismaUserRepository();
const getDocumentsUseCase = new GetDocumentsUseCase_1.GetDocumentsUseCase(documentRepository);
const getDocumentByIdUseCase = new GetDocumentByIdUseCase_1.GetDocumentByIdUseCase(documentRepository);
const signDocumentUseCase = new SignDocumentUseCase_1.SignDocumentUseCase(documentRepository, userRepository);
class DocumentController {
    async getAll(req, res) {
        try {
            const { status, from, to, search, page, pageSize } = req.query;
            const isAdmin = req.user?.role === 'ADMIN';
            const p = parseInt(page, 10);
            const ps = parseInt(pageSize, 10);
            const pageNum = Number.isFinite(p) && p > 0 ? p : 1;
            const sizeNum = Number.isFinite(ps) && ps > 0 ? Math.min(100, ps) : 24;
            const { items, total } = await getDocumentsUseCase.execute({
                lawyerId: isAdmin ? undefined : req.user?.userId,
                status: status,
                from: from ? new Date(from) : undefined,
                to: to ? new Date(to) : undefined,
                search: search?.trim() || undefined,
                page: pageNum,
                pageSize: sizeNum,
            });
            res.json({ items, total, page: pageNum, pageSize: sizeNum });
        }
        catch {
            res.status(500).json({ message: 'Error al obtener documentos' });
        }
    }
    async getById(req, res) {
        try {
            const id = req.params['id'];
            const document = await getDocumentByIdUseCase.execute(id);
            const isOwner = document.lawyerId === req.user?.userId;
            const isAdmin = req.user?.role === 'ADMIN';
            if (!isOwner && !isAdmin) {
                res.status(403).json({ message: 'Sin permiso para ver este documento' });
                return;
            }
            res.json(document);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error desconocido';
            res.status(404).json({ message });
        }
    }
    /**
     * Sobreescribe el .docx de la demanda en el NAS con la versión editada desde la
     * web (editor SuperDoc). No copia a S3 ni al disco del servidor: edita el archivo
     * original. Permitido al dueño de la demanda o a un ADMIN (no a demandas firmadas).
     */
    async saveFile(req, res) {
        try {
            const id = req.params['id'];
            const file = req.file;
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
            const meta = (document.metadata ?? {});
            const rel = meta.demandaRelPath
                ?? (document.fileUrl ? nas.relPathFromUrl(document.fileUrl) : null);
            if (!rel) {
                res.status(400).json({ message: 'No se pudo determinar la ruta del archivo en el NAS' });
                return;
            }
            nas.overwrite(rel, file.buffer);
            res.json({ success: true, message: 'Archivo sobrescrito en el NAS', fileUrl: document.fileUrl });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al guardar el archivo';
            res.status(400).json({ message });
        }
    }
    async sign(req, res) {
        try {
            const id = req.params['id'];
            const document = await signDocumentUseCase.execute({
                documentId: id,
                lawyerId: req.user.userId,
            });
            res.json(document);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al firmar';
            res.status(400).json({ message });
        }
    }
}
exports.DocumentController = DocumentController;
//# sourceMappingURL=DocumentController.js.map