import { apiClient } from './client';

export interface TransitoEntry {
  ciudad: string;
  entidad: string;
  correo: string;
}

export interface AppConfig {
  smmv: number;
  transito: TransitoEntry[];
  cuantiaMinimaMax: number;
  cuantiaMenorMax: number;
}

export const configApi = {
  get: () => apiClient.get<AppConfig>('/config').then((r) => r.data),
  update: (patch: { smmv?: number; transito?: TransitoEntry[] }) =>
    apiClient.patch<AppConfig>('/config', patch).then((r) => r.data),
};
