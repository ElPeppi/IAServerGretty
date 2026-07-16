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
  // Ruta relativa a la raíz del NAS (SAC_OUT_DIR). El backend la usa para servir
  // y sobreescribir el archivo desde el NAS sin copiarlo a su disco ni a S3.
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
  smmv?: number; // salario mínimo (umbrales de cuantía)
  transito?: Array<{ ciudad: string; entidad: string; correo: string }>; // directorio de tránsito
  soloCedulas?: string[]; // si viene, el motor SOLO procesa esas cédulas (regenerar una demanda)
}

export interface GenerateSingularOutput {
  success: boolean;
  totalFilas: number;
  clientes: EngineClientInfo[];
  documentos: EngineDocument[];
  omitidos: Array<{ cedula: string; nombre: string; motivo: string }>;
  errores?: Array<{ cedula: string; error: string }>;
  xlsxBase64: string;
}

// ─── Descarga de obligaciones del SAC por cédula (reemplaza el disparo por ZIP) ──
export interface DescargarSacInput {
  cedulas: string | string[]; // el motor las normaliza (separadas por "-", "," o espacios)
}

export interface DescargarSacItem {
  cedula: string;
  success: boolean;
  carpeta?: string;
  pdfsSAC?: string[];         // SAC_{ced}_DIRYTEL.pdf, SAC_{ced}_OBL{obl}.pdf, …
  contactos?: string | null;  // CONTACTOS_{ced}.csv
  error?: string;
}

export interface DescargarSacOutput {
  success: boolean;
  total: number;
  ok: number;
  resultados: DescargarSacItem[];
}

// ─── Generación del Word combinado de poderes (una asignación) ──────────────────
export interface GenerarPoderesInput {
  filas: Array<Record<string, unknown>>; // filas del Excel de asignación cacheadas
  docsEnServidor?: boolean;               // leer Nº pagaré del doc (si no, OBLIGACION del Excel)
  fechaAsignacion?: string;               // valida antigüedad de los docs (DD/MM/YYYY o ISO)
  nombre?: string;                        // nombre del lote → nombre del archivo Word
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
  poderPath?: string;           // ruta donde el motor guardó el Word (PODERES/{año})
  poderBase64?: string;         // el Word combinado (para que el backend lo sirva)
  docsEnServidor?: boolean;
  clientes: PoderClienteOut[];
  excluidos: Array<{ cedula: string; nombre?: string; motivo: string }>;
  error?: string;
}

export interface IEngineService {
  generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput>;
  descargarSac(input: DescargarSacInput): Promise<DescargarSacOutput>;
  generarPoderes(input: GenerarPoderesInput): Promise<GenerarPoderesOutput>;
}
