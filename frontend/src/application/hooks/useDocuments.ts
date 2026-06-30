import { useState, useEffect, useCallback } from 'react';
import type { Document, DocumentStatus } from '../../domain/types/document';
import { documentApi } from '../../infrastructure/api/documentApi';
import type { DocumentFilters, DocumentsPage } from '../../infrastructure/api/documentApi';

export function useDocuments(filters?: DocumentFilters) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error al cargar documentos');
    } finally {
      setIsLoading(false);
    }
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { documents, total, isLoading, error, refetch: fetch };
}

export function useDocument(id: string) {
  const [document, setDocument] = useState<Document | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);

  useEffect(() => {
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

  return { document, isLoading, error, isSigning, sign };
}
