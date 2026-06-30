import { IDocumentRepository, DocumentFilters } from '../../../domain/repositories/IDocumentRepository';

export class GetDocumentsUseCase {
  constructor(private readonly documentRepository: IDocumentRepository) {}

  async execute(filters?: DocumentFilters) {
    return this.documentRepository.findAll(filters);
  }
}
