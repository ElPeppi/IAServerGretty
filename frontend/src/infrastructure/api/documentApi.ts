import { apiClient } from './client';
import type { Document, DocumentStatus } from '../../domain/types/document';

export interface DocumentFilters {
  status?: DocumentStatus;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface DocumentsPage {
  items: Document[];
  total: number;
  page: number;
  pageSize: number;
}

export const documentApi = {
  getAll: (filters?: DocumentFilters) =>
    apiClient.get<DocumentsPage>('/documents', { params: filters }).then((r) => r.data),

  getById: (id: string) => apiClient.get<Document>(`/documents/${id}`).then((r) => r.data),

  sign: (id: string) => apiClient.post<Document>(`/documents/${id}/sign`).then((r) => r.data),

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
};
