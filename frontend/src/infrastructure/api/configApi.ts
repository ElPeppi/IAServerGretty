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

// Versiones anteriores de una plantilla, guardadas automáticamente al reemplazarla.
export interface PlantillaRespaldo {
  archivo: string;
  tamano: number;
  fecha: string;
}

// Plantillas .docx/.xlsx + firma. Viven en el DISCO del servidor (carpeta
// PLANTILLAS), no en Drive: cambiarlas en Drive no afecta la generación.
export interface Plantilla {
  clave: string;
  etiqueta: string;
  tipo: 'docx' | 'xlsx' | 'png';
  ruta: string;
  archivo: string;
  existe: boolean;
  tamano?: number;
  modificado?: string;
  hash?: string;
  respaldos: PlantillaRespaldo[];
}

// Resultado de reponer los insumos desde Drive.
export interface SyncResult {
  repuestos: string[]; // "destino/archivo" de lo que se bajó
  errores: string[];
  omitidos: number;    // ya estaban al día
  revisados: number;   // candidatos encontrados en Drive; 0 = no se encontró la carpeta
  plantillas: Plantilla[];
}

export const configApi = {
  get: () => apiClient.get<AppConfig>('/config').then((r) => r.data),
  update: (patch: { smmv?: number; transito?: TransitoEntry[] }) =>
    apiClient.patch<AppConfig>('/config', patch).then((r) => r.data),

  plantillas: () =>
    apiClient.get<{ plantillas: Plantilla[] }>('/config/plantillas').then((r) => r.data.plantillas),

  // Fuerza la sincronización desde Drive (normalmente ocurre sola antes de cada
  // lote). Solo ADMIN: el backend responde 403 si no.
  sincronizarPlantillas: () =>
    apiClient
      .post<SyncResult>('/config/plantillas/sincronizar', undefined, { timeout: 300000 })
      .then((r) => r.data),

  restaurarPlantilla: (clave: string, archivo: string) =>
    apiClient
      .post<{ success: boolean; plantilla?: Plantilla }>(`/config/plantillas/${clave}/restaurar`, { archivo })
      .then((r) => r.data),
};
