import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';
export declare class GetDashboardStatsUseCase {
    private readonly documentRepository;
    constructor(documentRepository: IDocumentRepository);
    execute(lawyerId?: string): Promise<import("../../../domain/repositories/IDocumentRepository").DashboardStats>;
}
//# sourceMappingURL=GetDashboardStatsUseCase.d.ts.map