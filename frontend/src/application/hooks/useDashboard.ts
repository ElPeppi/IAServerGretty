import { useState, useEffect, useCallback } from 'react';
import type { DashboardStats } from '../../domain/types/dashboard';
import { dashboardApi } from '../../infrastructure/api/dashboardApi';
import { useRefreshOnNotification } from '../context/NotificationContext';

export function useDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `silent`: refresco en segundo plano (no muestra el esqueleto de carga).
  const load = useCallback((silent = false) => {
    if (!silent) setIsLoading(true);
    dashboardApi
      .getStats()
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error al cargar estadísticas'))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Cuando el backend avisa que terminó una tarea de fondo (generación, ZIPs),
  // re-consultar las estadísticas para que los contadores se actualicen solos.
  useRefreshOnNotification(() => load(true));

  return { stats, isLoading, error, refetch: () => load(true) };
}
