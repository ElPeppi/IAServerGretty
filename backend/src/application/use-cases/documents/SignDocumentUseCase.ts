import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';
import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { IN8nService } from '../../services/IN8nService';

export interface SignDocumentInput {
  documentId: string;
  lawyerId: string;
}

export class SignDocumentUseCase {
  constructor(
    private readonly documentRepository: IDocumentRepository,
    private readonly userRepository: IUserRepository,
    private readonly n8nService: IN8nService
  ) {}

  async execute(input: SignDocumentInput) {
    const document = await this.documentRepository.findById(input.documentId);
    if (!document) throw new Error('Documento no encontrado');

    if (document.status === 'SIGNED') throw new Error('El documento ya está firmado');
    if (document.status !== 'GENERATED') throw new Error('El documento aún no ha sido generado');

    const lawyer = await this.userRepository.findById(input.lawyerId);
    if (!lawyer) throw new Error('Abogado no encontrado');
    if (!lawyer.signatureUrl) throw new Error('El abogado no tiene firma registrada');

    let signedUrl: string;
    try {
      signedUrl = await this.n8nService.signDocument({
        documentId: document.id,
        fileUrl: document.fileUrl!,
        lawyerName: lawyer.name,
        signatureUrl: lawyer.signatureUrl,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        throw new Error('n8n no está disponible. Verifica que el contenedor esté corriendo.');
      }
      if (status === 404) {
        throw new Error('El workflow de firma en n8n no está activo. Importa y activa "firmar-documento.json" en http://localhost:5678');
      }
      throw err;
    }

    return this.documentRepository.update(document.id, {
      status: 'SIGNED',
      signedUrl,
      signedAt: new Date(),
    });
  }
}
