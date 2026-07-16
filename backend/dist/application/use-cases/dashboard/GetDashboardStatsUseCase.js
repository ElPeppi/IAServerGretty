"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetDashboardStatsUseCase = void 0;
class GetDashboardStatsUseCase {
    constructor(documentRepository) {
        this.documentRepository = documentRepository;
    }
    async execute(lawyerId) {
        return this.documentRepository.getDashboardStats(lawyerId);
    }
}
exports.GetDashboardStatsUseCase = GetDashboardStatsUseCase;
//# sourceMappingURL=GetDashboardStatsUseCase.js.map