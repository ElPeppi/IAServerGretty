import { IDocumentRepository } from '../../../domain/repositories/IDocumentRepository';
import { IUserRepository } from '../../../domain/repositories/IUserRepository';
import { SignedPdfService } from '../../../infrastructure/services/SignedPdfService';
export interface SignDocumentInput {
    documentId: string;
    lawyerId: string;
}
/**
 * Firma una demanda: arma el PDF FINAL (demanda .docx → PDF + anexos + antecedentes)
 * y lo guarda en el NAS (carpeta del cliente, servido por /docs). La demanda ya trae
 * la firma estampada desde la generación; aquí se consolida en un único PDF firmado.
 * Ya NO depende de n8n.
 */
export declare class SignDocumentUseCase {
    private readonly documentRepository;
    private readonly userRepository;
    private readonly signedPdfService;
    constructor(documentRepository: IDocumentRepository, userRepository: IUserRepository, signedPdfService?: SignedPdfService);
    execute(input: SignDocumentInput): Promise<import("../../../domain/entities/Document").Document>;
}
//# sourceMappingURL=SignDocumentUseCase.d.ts.map