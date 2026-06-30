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
};
