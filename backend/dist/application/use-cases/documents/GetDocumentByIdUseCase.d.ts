import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';
export declare class GetDocumentByIdUseCase {
    private readonly documentRepository;
    constructor(documentRepository: IDocumentRepository);
    execute(id: string): Promise<import("../../../domain/entities/Document").DocumentWithLawyer>;
}
//# sourceMappingURL=GetDocumentByIdUseCase.d.ts.map