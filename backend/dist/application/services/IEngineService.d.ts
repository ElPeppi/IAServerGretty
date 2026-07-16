/**
 * IEngineService — contrato del MOTOR de generación de demandas (sac_scripts).
 * El backend lo invoca por HTTP en lugar de n8n. El motor consulta SAC/RUNT/RUES/
 * Rama Judicial y devuelve, por cliente, los archivos (base64) + las notas.
 */
export interface EngineNote {
    campo: string;
    nivel: 'info' | 'warning';
    mensaje: string;
}
export interface EngineFile {
    filename: string;
    mimeType: string;
    base64: string;
    relPath?: string;
}
export interface EngineDocument {
    cedula: string;
    nombre: string;
    notas: EngineNote[];
    archivos: {
        demanda?: EngineFile | null;
        anexos?: EngineFile | null;
        antecedentes?: EngineFile | null;
    };
}
export interface EngineClientInfo {
    cedula: string;
    nombre: string;
    ciudad?: string;
    cuantia?: string;
    valorCuantia?: number;
    numeroPagare?: string;
    tipoJuzgadoFinal?: string;
    correoJuzgado?: string;
    notas?: EngineNote[];
}
export interface GenerateSingularInput {
    excel: Buffer;
    excelFilename: string;
    correoPoder?: Buffer | null;
    correoPoderFilename?: string;
    fechaAsignacion?: string;
    smmv?: number;
    transito?: Array<{
        ciudad: string;
        entidad: string;
        correo: string;
    }>;
    soloCedulas?: string[];
}
export interface GenerateSingularOutput {
    success: boolean;
    totalFilas: number;
    clientes: EngineClientInfo[];
    documentos: EngineDocument[];
    omitidos: Array<{
        cedula: string;
        nombre: string;
        motivo: string;
    }>;
    errores?: Array<{
        cedula: string;
        error: string;
    }>;
    xlsxBase64: string;
}
export interface DescargarSacInput {
    cedulas: string | string[];
}
export interface DescargarSacItem {
    cedula: string;
    success: boolean;
    carpeta?: string;
    pdfsSAC?: string[];
    contactos?: string | null;
    error?: string;
}
export interface DescargarSacOutput {
    success: boolean;
    total: number;
    ok: number;
    resultados: DescargarSacItem[];
}
export interface GenerarPoderesInput {
    filas: Array<Record<string, unknown>>;
    docsEnServidor?: boolean;
    fechaAsignacion?: string;
    nombre?: string;
}
export interface PoderClienteOut {
    cedula: string;
    nombre?: string;
    ciudadJuzgado?: string;
    tipoJuzgado?: string;
    numeroPagare?: string;
    pagare?: string;
    pagareDesdeDocs?: boolean;
}
export interface GenerarPoderesOutput {
    success: boolean;
    poderFilename?: string;
    poderPath?: string;
    poderBase64?: string;
    docsEnServidor?: boolean;
    clientes: PoderClienteOut[];
    excluidos: Array<{
        cedula: string;
        nombre?: string;
        motivo: string;
    }>;
    error?: string;
}
export interface IEngineService {
    generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput>;
    descargarSac(input: DescargarSacInput): Promise<DescargarSacOutput>;
    generarPoderes(input: GenerarPoderesInput): Promise<GenerarPoderesOutput>;
}
//# sourceMappingURL=IEngineService.d.ts.map