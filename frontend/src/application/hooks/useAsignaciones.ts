import { useCallback, useEffect, useState } from 'react';
import { asignacionApi, type AsignacionResumen } from '../../infrastructure/api/asignacionApi';

export function useAsignaciones() {
  const [asignaciones, setAsignaciones] = useState<AsignacionResumen[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAsignaciones(await asignacionApi.listar());
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      setError(msg ?? (err instanceof Error ? err.message : 'Error al cargar asignaciones'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);

  return { asignaciones, isLoading, error, refetch };
}
