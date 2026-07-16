import { Document, DocumentWithLawyer } from '../../../domain/entities/Document';
import { IDocumentRepository, CreateDocumentDTO, UpdateDocumentDTO, DocumentFilters, PaginatedDocuments, DashboardStats } from '../../../domain/repositories/IDocumentRepository';
export declare class PrismaDocumentRepository implements IDocumentRepository {
    findById(id: string): Promise<DocumentWithLawyer | null>;
    findAll(filters?: DocumentFilters): Promise<PaginatedDocuments>;
    create(data: CreateDocumentDTO): Promise<Document>;
    update(id: string, data: UpdateDocumentDTO): Promise<Document>;
    getDashboardStats(lawyerId?: string): Promise<DashboardStats>;
}
//# sourceMappingURL=DocumentRepository.d.ts.map