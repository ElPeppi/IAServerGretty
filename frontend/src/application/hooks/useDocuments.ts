import { useState, useEffect, useCallback } from 'react';
import type { Document } from '../../domain/types/document';
import { documentApi } from '../../infrastructure/api/documentApi';
import type { DocumentFilters, DocumentsPage } from '../../infrastructure/api/documentApi';

export function useDocuments(filters?: DocumentFilters) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [demandantes, setDemandantes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Tolerante: acepta el sobre paginado { items, total } (backend nuevo) o un
      // array plano (backend viejo), para no quedarse en blanco si no coinciden.
      const data = (await documentApi.getAll(filters)) as DocumentsPage | Document[];
      const items = Array.isArray(data) ? data : data?.items ?? [];
      const totalCount = Array.isArray(data) ? data.length : data?.total ?? items.length;
      setDocuments(items);
      setTotal(totalCount);
      // Solo se pisa si vienen: al filtrar por un demandante el backend sigue
      // devolviendo la lista completa, pero un backend viejo no manda nada y
      // conservar las últimas evita que el selector se vacíe.
      if (!Array.isArray(data) && data?.demandantes) setDemandantes(data.demandantes);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar documentos');
    } finally {
      setIsLoading(false);
    }
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { documents, total, demandantes, isLoading, error, refetch: fetch };
}

export function useDocument(id: string) {
  const [document, setDocument] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const doc = await documentApi.getById(id);
      setDocument(doc);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar documento');
    }
  }, [id]);

  useEffect(() => {
    setIsLoading(true);
    documentApi
      .getById(id)
      .then(setDocument)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error al cargar documento'))
      .finally(() => setIsLoading(false));
  }, [id]);

  const sign = async () => {
    setIsSigning(true);
    try {
      const updated = await documentApi.sign(id);
      setDocument(updated);
      return updated;
    } finally {
      setIsSigning(false);
    }
  };

  // Dispara la regeneración (segundo plano). El documento se refresca solo al
  // llegar la notificación SSE de "generación terminada" (ver DocumentDetailPage).
  // `correoPoderRel` opcional: ruta de uno de los correos guardados en el servidor.
  // Si no se manda, se usa el de la asignación (400 SIN_CORREO_PODER si no hay).
  const regenerar = async (correoPoderRel?: string) => {
    setIsRegenerating(true);
    try {
      return await documentApi.regenerar(id, correoPoderRel);
    } finally {
      setIsRegenerating(false);
    }
  };

  return { document, isLoading, error, isSigning, sign, isRegenerating, regenerar, refetch };
}
