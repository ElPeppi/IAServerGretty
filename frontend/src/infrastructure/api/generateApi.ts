import { apiClient } from './client';

export interface SingularResult {
  success: boolean;
  started?: boolean;   // la generación corre en segundo plano (202)
  message?: string;
  count?: number;
  documentIds?: string[];
  totalFilas?: number;
  omitidos?: Array<{ cedula: string; nombre: string; motivo: string }>;
  errores?: Array<{ cedula: string; error: string }>;
}

export interface DescargarSacItem {
  cedula: string;
  success: boolean;
  pdfsSAC?: string[];
  contactos?: string | null;
  error?: string;
}

// La descarga corre EN SEGUNDO PLANO: la respuesta solo confirma que se encoló.
// El avance llega por SSE (una notificación por cédula que termina + una final).
export interface DescargarSacResult {
  success: boolean;
  started?: boolean;
  total: number;
  cedulas?: string[];
  message?: string;
  ok?: number;
  resultados?: DescargarSacItem[];
}

export const generateApi = {
  fromExcel: (file: File, meta: { clientName?: string; clientRfc?: string; templateType?: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (meta.clientName)   form.append('clientName', meta.clientName);
    if (meta.clientRfc)    form.append('clientRfc', meta.clientRfc);
    if (meta.templateType) form.append('templateType', meta.templateType);

    return apiClient
      .post<{ success: boolean; documentId: string }>('/generate/from-excel', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  /**
   * Genera demandas singulares con el motor real. `excel` es la asignación;
   * `correoPoder` (opcional) es el correo PDF del banco para el ANEXO 1.
   * Crea un documento por cliente.
   */
  singular: (excel: File, opts: { correoPoder?: File | null; fechaAsignacion?: string } = {}) => {
    const form = new FormData();
    form.append('excelFile', excel);
    if (opts.correoPoder)    form.append('correoPoder', opts.correoPoder);
    if (opts.fechaAsignacion) form.append('fechaAsignacion', opts.fechaAsignacion);

    return apiClient
      .post<SingularResult>('/generate/singular', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 600000,
      })
      .then((r) => r.data);
  },

  /**
   * Descarga las obligaciones del SAC (reemplaza el disparo por ZIP). Las cédulas
   * pueden venir de dos fuentes combinables: `cedulas` (texto separado por "-", ","
   * o espacios) y/o `excel` (el Excel de asignación; se sacan de la columna
   * IDENTIFICACION). Devuelve apenas se encola: el scraping sigue en segundo
   * plano y avisa por notificaciones (SSE) a medida que termina cada persona.
   */
  descargarSac: (cedulas: string, excel?: File | null) => {
    const form = new FormData();
    if (cedulas) form.append('cedulas', cedulas);
    if (excel)   form.append('excelFile', excel);
    return apiClient
      .post<DescargarSacResult>('/generate/descargar-sac', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 60000,
      })
      .then((r) => r.data);
  },
};
