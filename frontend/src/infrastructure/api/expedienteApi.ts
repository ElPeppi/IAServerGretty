import { apiClient } from './client';

export interface ArchivoExpediente {
  nombre: string;
  relPath: string;
  url: string;    // /docs/… → se puede abrir o incrustar directamente
  tipo: string;   // SAC | PAGARE | DATACREDITO | DEMANDA | …
}

export interface CarpetaExpediente {
  proceso: 'singular' | 'pago_directo';
  procesoNombre: string;  // "EJECUTIVAS SINGULARES" | "GARANTIA MOBILIARIAS"
  nombre: string;         // nombre real de la carpeta en el servidor
  relPath: string;
  archivos: ArchivoExpediente[];
}

export interface Expediente {
  cedula: string;
  banco: string;
  carpetas: CarpetaExpediente[];
  total: number;
}

// Correo del banco que otorga el poder (ANEXO 1), ya guardado en el servidor.
export interface CorreoPoder {
  nombre: string;
  relPath: string;
  url: string;
  fecha: string | null;   // "2026-07-10" si la trae el nombre
  carpeta: string;        // subcarpeta (año) o '' si está suelto
}

// Datos del pagaré que el OCR NO puede leer del escaneado y se capturan a mano.
// Lo guardado manda sobre el motor en la próxima generación/regeneración.
export interface DatosManuales {
  numeroPagare: string;
  fechaSuscripcion: string;   // DD/MM/AAAA
  nota: string;
  actualizadoAt: string | null;
}

export const expedienteApi = {
  // Correos de otorgamiento disponibles, del más reciente al más viejo.
  correosPoder: (proceso: 'singular' | 'pago_directo' = 'singular') =>
    apiClient
      .get<{ correos: CorreoPoder[] }>('/expedientes/_correos-poder', { params: { proceso } })
      .then((r) => r.data.correos),

  // Documentos que tiene un cliente en el servidor (todas sus carpetas).
  ver: (cedula: string) =>
    apiClient.get<Expediente>(`/expedientes/${encodeURIComponent(cedula)}`).then((r) => r.data),

  // Datos capturados a mano de esa cédula (vacíos si nunca se capturó nada).
  datosManuales: (cedula: string) =>
    apiClient
      .get<DatosManuales>(`/expedientes/${encodeURIComponent(cedula)}/datos-manuales`)
      .then((r) => r.data),

  // Guardar/actualizar. Un campo vacío BORRA el valor (vuelve a lo que lea el motor).
  guardarDatosManuales: (cedula: string, datos: { numeroPagare?: string; fechaSuscripcion?: string; nota?: string }) =>
    apiClient
      .put<DatosManuales>(`/expedientes/${encodeURIComponent(cedula)}/datos-manuales`, datos)
      .then((r) => r.data),

  // Borrado real. Lo hace el backend, que actúa como la cuenta dueña de los
  // archivos — desde Drive un editor solo puede "quitarlos de la vista".
  borrarArchivo: (cedula: string, relPath: string) =>
    apiClient
      .delete<{ success: boolean }>(`/expedientes/${encodeURIComponent(cedula)}/archivo`, {
        data: { relPath },
      })
      .then((r) => r.data),
};
