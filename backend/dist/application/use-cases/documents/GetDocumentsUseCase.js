"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetDocumentsUseCase = void 0;
class GetDocumentsUseCase {
    constructor(documentRepository) {
        this.documentRepository = documentRepository;
    }
    async execute(filters) {
        return this.documentRepository.findAll(filters);
    }
}
exports.GetDocumentsUseCase = GetDocumentsUseCase;
//# sourceMappingURL=GetDocumentsUseCase.js.map