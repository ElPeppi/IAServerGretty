import { Request, Response } from 'express';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { DocumentStatus } from '../../domain/entities/Document';

const documentRepository = new PrismaDocumentRepository();
const userRepository = new PrismaUserRepository();

// This endpoint is called BY n8n after it finishes generating/signing a document
export class WebhookController {
  // n8n calls this after generating a demand from Excel
  async documentGenerated(req: Request, res: Response): Promise<void> {
    try {
      const { lawyerId, title, clientName, clientRfc, description, fileUrl, metadata, type } =
        req.body;

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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error interno';
      res.status(500).json({ message });
    }
  }

  // n8n calls this to update document status
  async updateStatus(req: Request, res: Response): Promise<void> {
    try {
      const { documentId, status, fileUrl, signedUrl } = req.body;

      if (!documentId || !status) {
        res.status(400).json({ message: 'documentId y status son requeridos' });
        return;
      }

      const validStatuses: DocumentStatus[] = ['PENDING', 'GENERATED', 'SIGNED', 'REJECTED'];
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error interno';
      res.status(500).json({ message });
    }
  }
}
