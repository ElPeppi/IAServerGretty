import { apiClient } from './client';

export interface AsignacionResumen {
  id: string;
  nombre: string;
  fechaAsignacion: string | null;
  totalFilas: number;
  tienePoder: boolean;
  poderUrl: string | null;
  poderGeneradoAt: string | null;
  docsEnServidor: boolean;
  correoPoderUrl: string | null; // PDF del correo del banco guardado para el ANEXO 1
  poderesCacheados: number;
  demandas: number;
  createdAt: string;
}

export interface GenerarPoderesResult {
  success: boolean;
  poderUrl?: string;
  poderFilename?: string;
  generados: number;
  excluidos: Array<{ cedula: string; nombre?: string; motivo: string }>;
}

export interface AsignacionPersona {
  cedula: string;
  nombre: string;
  tipo: string; // etiqueta normalizada: EJECUTIVO SINGULAR / RESTITUCIÓN / TRÁMITE PAGO DIRECTO / SIN PROCESO
}

export const asignacionApi = {
  listar: () =>
    apiClient.get<{ asignaciones: AsignacionResumen[] }>('/asignaciones').then((r) => r.data.asignaciones),

  // Personas (cédula + nombre) de una asignación, para elegir a quién bajar del SAC.
  personas: (id: string) =>
    apiClient.get<{ personas: AsignacionPersona[] }>(`/asignaciones/${id}/personas`).then((r) => r.data.personas),

  // Sube el Excel de asignación → lo CACHEA (ya no genera demandas).
  subir: (excel: File, fechaAsignacion?: string) => {
    const form = new FormData();
    form.append('excelFile', excel);
    if (fechaAsignacion) form.append('fechaAsignacion', fechaAsignacion);
    return apiClient
      .post<{ success: boolean; asignacion: AsignacionResumen }>('/asignaciones', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  // Escanea el servidor y agrega las asignaciones que falten en la DB.
  actualizar: () =>
    apiClient
      .post<{ success: boolean; escaneadas: number; agregadas: number; nuevas: string[] }>('/asignaciones/actualizar')
      .then((r) => r.data),

  // Enlaza un Word de poderes ya hecho (subido a mano) a la asignación.
  subirPoder: (id: string, poder: File) => {
    const form = new FormData();
    form.append('poderFile', poder);
    return apiClient
      .post<{ success: boolean; poderUrl: string }>(`/asignaciones/${id}/poder`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  // Genera el Word combinado de poderes de una asignación. `cedulas` (opcional) =
  // subconjunto; vacío/omitido = todas (solo proceso ejecutivo singular).
  generarPoderes: (id: string, docsEnServidor: boolean, cedulas?: string[]) =>
    apiClient
      .post<GenerarPoderesResult>(
        `/asignaciones/${id}/generar-poderes`,
        { docsEnServidor, ...(cedulas && cedulas.length ? { cedulas } : {}) },
        { timeout: 3600000 },
      )
      .then((r) => r.data),

  // Genera las demandas de la asignación reusando el poder cacheado (segundo plano).
  // `cedulas` (opcional) = subconjunto a generar; vacío/omitido = todas las que el
  // motor acepte (solo ejecutivo singular). `correoPoder` (opcional) = PDF del correo
  // del banco para el ANEXO 1; si no se manda, se reusa el guardado en la asignación.
  // Lanza 409 { codigo: 'SIN_PODER' } si no hay poder enlazado.
  generarDemandas: (id: string, cedulas?: string[], correoPoder?: File | null) => {
    const form = new FormData();
    if (cedulas && cedulas.length) form.append('cedulas', JSON.stringify(cedulas));
    if (correoPoder) form.append('correoPoder', correoPoder);
    return apiClient
      .post<{ success: boolean; started: boolean; message: string }>(
        `/asignaciones/${id}/generar-demandas`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      .then((r) => r.data);
  },
};
