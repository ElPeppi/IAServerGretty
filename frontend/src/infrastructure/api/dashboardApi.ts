import { apiClient } from './client';
import type { DashboardStats, Observacion } from '../../domain/types/dashboard';

export const dashboardApi = {
  getStats: () => apiClient.get<DashboardStats>('/dashboard/stats').then((r) => r.data),
  getObservaciones: () =>
    apiClient.get<Observacion[]>('/dashboard/observaciones').then((r) => r.data),
};
