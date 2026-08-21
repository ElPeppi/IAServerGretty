import { Document, DocumentNote, DocumentStatus, DocumentWithLawyer } from '../entities/Document';

export interface CreateDocumentDTO {
  title: string;
  type?: string;
  status?: DocumentStatus;
  clientName: string;
  clientRfc?: string;
  clientCedula?: string;
  description?: string;
  fileUrl?: string;
  anexosUrl?: string;
  antecedentesUrl?: string;
  asignacionUrl?: string;
  poderUrl?: string;
  notes?: DocumentNote[];
  lawyerId: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateDocumentDTO {
  status?: DocumentStatus;
  fileUrl?: string;
  signedUrl?: string;
  anexosUrl?: string;
  antecedentesUrl?: string;
  asignacionUrl?: string;
  poderUrl?: string;
  notes?: DocumentNote[];
  signedAt?: Date;
  title?: string;
}

export interface DocumentFilters {
  lawyerId?: string;
  status?: DocumentStatus;
  from?: Date;
  to?: Date;
  search?: string;     // busca en nombre, cédula, título y RFC
  banco?: string;      // DEMANDANTE (FINANDINA, LIBERTADOR…)
  tipo?: string;       // proceso: DEMANDA_SINGULAR | DEMANDA_PAGO_DIRECTO
  page?: number;       // 1-based
  pageSize?: number;
}

export interface PaginatedDocuments {
  items: DocumentWithLawyer[];
  total: number;
}

export interface DashboardStats {
  totalDocuments: number;
  generatedToday: number;
  generatedThisWeek: number;
  generatedThisMonth: number;
  byStatus: Record<DocumentStatus, number>;
  byDay: Array<{ date: string; count: number }>;
  byWeek: Array<{ week: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}

export interface IDocumentRepository {
  findById(id: string): Promise<DocumentWithLawyer | null>;
  findAll(filters?: DocumentFilters): Promise<PaginatedDocuments>;
  create(data: CreateDocumentDTO): Promise<Document>;
  update(id: string, data: UpdateDocumentDTO): Promise<Document>;
  getDashboardStats(lawyerId?: string): Promise<DashboardStats>;
}
