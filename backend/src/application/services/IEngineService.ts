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

export interface IEngineService {
  generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput>;
}
