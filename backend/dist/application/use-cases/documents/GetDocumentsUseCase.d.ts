import { IDocumentRepository, DocumentFilters } from '../../../domain/repositories/IDocumentRepository';
export declare class GetDocumentsUseCase {
    private readonly documentRepository;
    constructor(documentRepository: IDocumentRepository);
    execute(filters?: DocumentFilters): Promise<import("../../../domain/repositories/IDocumentRepository").PaginatedDocuments>;
}
//# sourceMappingURL=GetDocumentsUseCase.d.ts.map