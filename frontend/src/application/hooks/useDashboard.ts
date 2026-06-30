import { useState, useEffect } from 'react';
import type { DashboardStats } from '../../domain/types/dashboard';
import { dashboardApi } from '../../infrastructure/api/dashboardApi';

export function useDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dashboardApi
      .getStats()
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error al cargar estadísticas'))
      .finally(() => setIsLoading(false));
  }, []);

  return { stats, isLoading, error };
}
