"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetDocumentByIdUseCase = void 0;
class GetDocumentByIdUseCase {
    constructor(documentRepository) {
        this.documentRepository = documentRepository;
    }
    async execute(id) {
        const document = await this.documentRepository.findById(id);
        if (!document) {
            throw new Error('Documento no encontrado');
        }
        return document;
    }
}
exports.GetDocumentByIdUseCase = GetDocumentByIdUseCase;
//# sourceMappingURL=GetDocumentByIdUseCase.js.map