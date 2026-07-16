"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const DocumentRepository_1 = require("../../infrastructure/database/prisma/DocumentRepository");
const UserRepository_1 = require("../../infrastructure/database/prisma/UserRepository");
const documentRepository = new DocumentRepository_1.PrismaDocumentRepository();
const userRepository = new UserRepository_1.PrismaUserRepository();
// This endpoint is called BY n8n after it finishes generating/signing a document
class WebhookController {
    // n8n calls this after generating a demand from Excel
    async documentGenerated(req, res) {
        try {
            const { lawyerId, title, clientName, clientRfc, description, fileUrl, metadata, type } = req.body;
            if (!lawyerId || !title || !clientName || !fileUrl) {
                res.status(400).json({ message: 'Campos requeridos: lawyerId, title, clientName, fileUrl' });
                return;
            }
            const lawyer = await userRepository.findById(lawyerId);
            if (!lawyer) {
                res.status(404).json({ message: 'Abogado no encontrado' });
                return;
            }
            const document = await documentRepository.create({
                title,
                type: type ?? 'DEMANDA',
                clientName,
                clientRfc,
                description,
                fileUrl,
                lawyerId,
                metadata,
            });
            await documentRepository.update(document.id, { status: 'GENERATED' });
            res.status(201).json({ success: true, documentId: document.id });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error interno';
            res.status(500).json({ message });
        }
    }
    // n8n calls this to update document status
    async updateStatus(req, res) {
        try {
            const { documentId, status, fileUrl, signedUrl } = req.body;
            if (!documentId || !status) {
                res.status(400).json({ message: 'documentId y status son requeridos' });
                return;
            }
            const validStatuses = ['PENDING', 'GENERATED', 'SIGNED', 'REJECTED'];
            if (!validStatuses.includes(status)) {
                res.status(400).json({ message: 'Status inválido' });
                return;
            }
            await documentRepository.update(documentId, {
                status,
                ...(fileUrl && { fileUrl }),
                ...(signedUrl && { signedUrl }),
                ...(status === 'SIGNED' && { signedAt: new Date() }),
            });
            res.json({ success: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error interno';
            res.status(500).json({ message });
        }
    }
}
exports.WebhookController = WebhookController;
//# sourceMappingURL=WebhookController.js.map