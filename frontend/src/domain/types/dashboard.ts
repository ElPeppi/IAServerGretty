import type { DocumentStatus } from './document';

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

// Cliente del Excel para el que NO se generó la demanda y por qué.
export interface Observacion {
  id: string;
  cedula: string;
  nombre?: string | null;
  motivo: string;
  lote?: string | null;
  createdAt: string;
}
