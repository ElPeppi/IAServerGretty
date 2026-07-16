import { NasStorage } from './NasStorage';
import { Document } from '../../domain/entities/Document';
export interface SignedPdfResult {
    relPath: string;
    url: string;
    pages: number;
}
export declare class SignedPdfService {
    private readonly nas;
    constructor(nas?: NasStorage);
    /** Convierte bytes de un .docx a PDF (Buffer) usando LibreOffice headless. */
    private docxToPdf;
    /** URL pública guardada (anexos/antecedentes) → ruta ABSOLUTA en el NAS, si existe. */
    private absFromUrl;
    private appendPdf;
    /**
     * Arma el PDF firmado (demanda + anexos + antecedentes) y lo guarda en el NAS.
     * Devuelve la URL pública y la ruta relativa.
     */
    build(document: Document): Promise<SignedPdfResult>;
}
//# sourceMappingURL=SignedPdfService.d.ts.map