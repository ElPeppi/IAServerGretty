"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignDocumentUseCase = void 0;
const SignedPdfService_1 = require("../../../infrastructure/services/SignedPdfService");
/**
 * Firma una demanda: arma el PDF FINAL (demanda .docx → PDF + anexos + antecedentes)
 * y lo guarda en el NAS (carpeta del cliente, servido por /docs). La demanda ya trae
 * la firma estampada desde la generación; aquí se consolida en un único PDF firmado.
 * Ya NO depende de n8n.
 */
class SignDocumentUseCase {
    constructor(documentRepository, userRepository, signedPdfService = new SignedPdfService_1.SignedPdfService()) {
        this.documentRepository = documentRepository;
        this.userRepository = userRepository;
        this.signedPdfService = signedPdfService;
    }
    async execute(input) {
        const document = await this.documentRepository.findById(input.documentId);
        if (!document)
            throw new Error('Documento no encontrado');
        if (document.status === 'SIGNED')
            throw new Error('El documento ya está firmado');
        if (document.status !== 'GENERATED')
            throw new Error('El documento aún no ha sido generado');
        const lawyer = await this.userRepository.findById(input.lawyerId);
        if (!lawyer)
            throw new Error('Abogado no encontrado');
        // Genera el PDF unido y firmado, y lo guarda en el NAS.
        const { url } = await this.signedPdfService.build(document);
        return this.documentRepository.update(document.id, {
            status: 'SIGNED',
            signedUrl: url,
            signedAt: new Date(),
        });
    }
}
exports.SignDocumentUseCase = SignDocumentUseCase;
//# sourceMappingURL=SignDocumentUseCase.js.map