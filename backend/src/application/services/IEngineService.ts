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

// Datos que el motor NO puede leer del pagaré y se capturan a mano en la web
// (pagaré escaneado: el OCR no lee el nº impreso ni la fecha manuscrita).
// Lo que venga aquí MANDA sobre lo que lea el motor, por cédula.
export interface DatoManualCliente {
  numeroPagare?: string;
  fechaSuscripcion?: string; // DD/MM/YYYY
}
export type CorreccionesPorCedula = Record<string, DatoManualCliente>;

export interface GenerateSingularInput {
  excel: Buffer;
  excelFilename: string;
  correoPoder?: Buffer | null;
  correoPoderFilename?: string;
  fechaAsignacion?: string;
  smmv?: number; // salario mínimo (umbrales de cuantía)
  transito?: Array<{ ciudad: string; entidad: string; correo: string }>; // directorio de tránsito
  soloCedulas?: string[]; // si viene, el motor SOLO procesa esas cédulas (regenerar una demanda)
  correcciones?: CorreccionesPorCedula; // datos capturados a mano (mandan sobre el OCR)
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

// El motor responde 202 en cuanto encola el lote y sigue en segundo plano: el
// avance llega por SSE (una notificación por cédula + una final). Por eso ya no
// vienen `ok`/`resultados` en la respuesta inmediata.
export interface DescargarSacOutput {
  success: boolean;
  started?: boolean;
  total: number;
  cedulas?: string[];
  message?: string;
  ok?: number;
  resultados?: DescargarSacItem[];
}

// ─── Generación del Word combinado de poderes (una asignación) ──────────────────
// Tipo de proceso del poder. 'singular' = ejecutivo singular (el de siempre);
// 'pago_directo' = trámite de pago directo / garantía mobiliaria (Ley 1676/2013),
// que usa otra plantilla y pide la aprehensión y entrega del vehículo.
export type TipoPoder = 'singular' | 'pago_directo';

export interface GenerarPoderesInput {
  excel: Buffer;                          // Excel ORIGINAL (Hoja1 + Hoja2) de la asignación
  tipo?: TipoPoder;                       // por defecto 'singular'
  docsEnServidor?: boolean;               // leer Nº pagaré del doc (si no, OBLIGACION del Excel)
  fechaAsignacion?: string;               // año de la carpeta PODERES/{año} (DD/MM/YYYY o ISO)
  nombre?: string;                        // nombre del lote → nombre del archivo Word
  smmv?: number;                          // salario mínimo (umbrales de cuantía → tipo de juzgado)
  soloCedulas?: string[];                 // subconjunto a generar; vacío/omitido = todas (singular)
  correcciones?: CorreccionesPorCedula;   // nº de pagaré capturado a mano (manda sobre docs/Excel)
}

export interface PoderClienteOut {
  cedula: string;
  nombre?: string;
  ciudadJuzgado?: string;
  tipoJuzgado?: string;
  numeroPagare?: string;
  pagare?: string;
  pagareDesdeDocs?: boolean;
  // Solo en 'pago_directo': el vehículo dado en garantía que se va a aprehender.
  placa?: string;
  marca?: string;
  modelo?: string;
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

// ─── Mapeo de columnas del Excel de asignación ──────────────────────────────────
// Los Excel del banco cambian de encabezados en cada envío. El motor ya resuelve
// "qué columna es qué" (heurística + Ollama local, validando el CONTENIDO de la
// columna propuesta); el backend lo reusa en vez de tener su propia versión.
export interface MapearColumnasInput {
  headers: string[];
  filas: unknown[][]; // muestra de filas, por índice de columna
}

export interface MapearColumnasOutput {
  success: boolean;
  mapeo: Record<string, number>;    // CAMPO → índice de columna
  porNombre: Record<string, string>; // CAMPO → nombre del encabezado
  error?: string;
}

// ─── Plantillas ────────────────────────────────────────────────────────────────
// Las plantillas (.docx/.xlsx) y la firma NO viven en Drive: el motor las lee del
// disco, de las rutas de su propio config. Por eso reemplazarlas es cosa suya y el
// backend solo hace de puerta autenticada.
export interface PlantillaRespaldo {
  archivo: string;
  tamano: number;
  fecha: string;
}

export interface PlantillaInfo {
  clave: string;
  etiqueta: string;
  tipo: 'docx' | 'xlsx' | 'png';
  ruta: string;
  archivo: string;
  existe: boolean;
  tamano?: number;
  modificado?: string;
  hash?: string;
  respaldos: PlantillaRespaldo[];
}

export interface PlantillaResult {
  success: boolean;
  respaldo?: string | null;
  plantilla?: PlantillaInfo;
  error?: string;
}

// Carpetas de insumos que el MOTOR declara necesitar, con lo que ya tiene dentro.
// El backend las surte desde Drive (ver storage/sincronizarInsumos.ts).
export interface InsumoDestino {
  destino: string;   // 'plantillas' | 'anexos_demandas' | 'anexos_finandina'
  etiqueta: string;
  dir: string;       // carpeta en el disco del servidor (informativo)
  /** Nombres admitidos, o `null` si vale cualquier PDF de la carpeta. */
  requeridos: string[] | null;
  archivos: Array<{ archivo: string; tamano: number; hash: string }>;
}

export interface SubirInsumoInput {
  destino: string;
  nombre: string;
  archivo: Buffer;
}

export interface IEngineService {
  generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput>;
  descargarSac(input: DescargarSacInput): Promise<DescargarSacOutput>;
  generarPoderes(input: GenerarPoderesInput): Promise<GenerarPoderesOutput>;
  mapearColumnas(input: MapearColumnasInput): Promise<MapearColumnasOutput>;
  listarPlantillas(): Promise<PlantillaInfo[]>;
  restaurarPlantilla(clave: string, archivo: string): Promise<PlantillaResult>;
  listarInsumos(): Promise<InsumoDestino[]>;
  subirInsumo(input: SubirInsumoInput): Promise<void>;
}
