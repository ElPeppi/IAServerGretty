import { apiClient } from './client';

// Libertador NO trabaja por lotes como Finandina: no llega un Excel con N
// deudores, los casos entran de uno en uno y la unidad real es la SOLICITUD.
// Por eso tiene su propio recurso y no reusa /asignaciones.
export interface LibertadorCaso {
  solicitud: string;
  proceso: string;
  // Fecha tal como la escribe el cuadro (dd/mm/aaaa). Llega como texto y se
  // pinta como texto: `new Date()` leería 05/03/2025 como 3 de mayo.
  recibido: string;
  cedula: string;
  demandante: string;
  demandado: string;
  ciudad: string;
  // Importe ya formateado en el origen ("$900.000,00"). No se reformatea en la
  // pantalla para no inventar una moneda ni perder los decimales del cuadro.
  canon: string;
  observaciones: string;
  documentacion: string;           // valor crudo de la columna "DOCUMENTACION COMPLETA"
  documentacionCompleta: boolean;  // normalizado por el backend (hay un "Si" en minúscula en el cuadro)
  mesGrab: string;                 // columna BD "MES GRAB"; vacía = caso pendiente
  // Fila del cuadro de origen: es la única forma de volver a encontrar el caso
  // a mano cuando algo no cuadra.
  fila: number;
}

export interface LibertadorCasosResponse {
  fuente: string; // nombre del cuadro del que se leyeron los casos
  total: number;
  sinDocumentacion: number; // cuántos casos esperan documentación
  sinMesGrab: number;       // cuántos casos tienen la columna BD "MES GRAB" vacía
  casos: LibertadorCaso[];
}

// Una solicitud que llegó en un correo de ASIGNACION (n8n → backend), con en qué
// va cada paso automático. Llega al instante, antes de aparecer en el cuadro.
export type EstadoCarpeta = 'creada' | 'existente' | 'error';
export type EstadoAnexos = 'pendiente' | 'ok' | 'sin_anexos' | 'error';
export type EstadoFormulario = 'pendiente' | 'enviado' | 'ya_enviado' | 'error' | 'apagado';

export interface LibertadorRecibida {
  solicitud: string;
  procesos: string[];
  tipoAlistamiento: string | null;
  estadoSiniestro: string | null;
  canon: number | null;
  deuda: number | null;
  asuntoCorreo: string | null;
  vecesRecibida: number;
  recibidaEn: string;        // ISO: primera vez que llegó
  ultimaRecepcion: string;   // ISO
  carpetaEstado: EstadoCarpeta | null;
  carpetaNombre: string | null;
  carpetaDetalle: string | null;
  anexosEstado: EstadoAnexos | null;
  anexosCantidad: number | null;
  anexosDetalle: string | null;
  formularioEstado: EstadoFormulario | null;
  formularioDetalle: string | null;
}

export const libertadorApi = {
  // Lo que llegó por correo en los últimos 60 días, lo más reciente primero.
  recibidas: () =>
    apiClient.get<{ solicitudes: LibertadorRecibida[] }>('/libertador/recibidas').then((r) => r.data.solicitudes),

  // Pide los estados de cuenta de un conjunto de solicitudes. Responde 202: el
  // portal tarda minutos y el resultado llega por notificación.
  estadosCuenta: (solicitudes: string[]) =>
    apiClient
      .post<{ success: boolean; started: boolean; total: number; message: string }>(
        '/libertador/estados-cuenta',
        { solicitudes },
      )
      .then((r) => r.data),

  // Puede responder 503 { message } mientras el cuadro no esté configurado: es
  // un estado normal de la instalación, no un fallo, y la pantalla lo trata así.
  casos: () => apiClient.get<LibertadorCasosResponse>('/libertador/casos').then((r) => r.data),
};
