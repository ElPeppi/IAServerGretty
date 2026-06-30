import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';

export class GetDocumentByIdUseCase {
  constructor(private readonly documentRepository: IDocumentRepository) {}

  async execute(id: string) {
    const document = await this.documentRepository.findById(id);
    if (!document) {
      throw new Error('Documento no encontrado');
    }
    return document;
  }
}
