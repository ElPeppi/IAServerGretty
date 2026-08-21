import { apiClient } from './client';
import type { Document, DocumentStatus } from '../../domain/types/document';

export interface DocumentFilters {
  status?: DocumentStatus;
  from?: string;
  to?: string;
  search?: string;
  banco?: string;   // DEMANDANTE
  tipo?: string;    // proceso: DEMANDA_SINGULAR | DEMANDA_PAGO_DIRECTO
  page?: number;
  pageSize?: number;
}

export interface DocumentsPage {
  items: Document[];
  total: number;
  page: number;
  pageSize: number;
  // Demandantes con documentos, para poblar el filtro sin lista fija de bancos.
  demandantes?: string[];
}

export const documentApi = {
  getAll: (filters?: DocumentFilters) =>
    apiClient.get<DocumentsPage>('/documents', { params: filters }).then((r) => r.data),

  getById: (id: string) => apiClient.get<Document>(`/documents/${id}`).then((r) => r.data),

  sign: (id: string) => apiClient.post<Document>(`/documents/${id}/sign`).then((r) => r.data),

  /**
   * Regenera SOLO esta demanda (corre en segundo plano; responde 202).
   * `correoPoder` (PDF del banco → ANEXO 1) es opcional: si no se manda, el
   * backend reusa el guardado en la asignación. Si no hay ninguno responde 400
   * con `codigo: 'SIN_CORREO_PODER'` y hay que adjuntarlo.
   */
  regenerar: (id: string, correoPoderRel?: string) => {
    const form = new FormData();
    if (correoPoderRel) form.append('correoPoderRel', correoPoderRel);
    return apiClient
      .post<{ success: boolean; started: boolean; message: string }>(
        `/documents/${id}/regenerar`,
        correoPoderRel ? form : undefined,
        correoPoderRel ? { headers: { 'Content-Type': 'multipart/form-data' } } : undefined,
      )
      .then((r) => r.data);
  },

  /** Sobreescribe el .docx de la demanda en el NAS con la versión editada. */
  saveFile: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    // Content-Type undefined → el navegador pone "multipart/form-data; boundary=…"
    // (si se fija a mano se pierde el boundary y multer no puede parsear).
    return apiClient
      .put<Document>(`/documents/${id}/file`, form, { headers: { 'Content-Type': undefined } })
      .then((r) => r.data);
  },

  /** Sobreescribe el .xlsx de asignación (Excel del lote) en el NAS. */
  saveAsignacion: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiClient
      .put<{ success: boolean; message: string }>(`/documents/${id}/asignacion`, form, { headers: { 'Content-Type': undefined } })
      .then((r) => r.data);
  },
};
