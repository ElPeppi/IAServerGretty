import { apiClient } from './client';

export interface AsignacionResumen {
  id: string;
  nombre: string;
  // DEMANDANTE del lote (FINANDINA, LIBERTADOR…). Lo deriva el backend del
  // contenido del Excel al subirlo, o de la carpeta al importarlo del árbol.
  banco: string;
  fechaAsignacion: string | null;
  totalFilas: number;
  tienePoder: boolean;
  tienePoderPagoDirecto: boolean;
  poderUrl: string | null;
  poderGeneradoAt: string | null;
  docsEnServidor: boolean;
  correoPoderUrl: string | null; // PDF del correo del banco guardado para el ANEXO 1
  poderesCacheados: number;
  demandas: number;
  demandasPendientes: number; // clientes del Excel que aún no tienen demanda
  createdAt: string;
}

// Proceso del poder. Debe coincidir con `TipoPoder` del backend.
export type TipoPoder = 'singular' | 'pago_directo';

// Etiqueta del proceso (la que devuelve /personas) → parámetro que espera la API.
// Solo los procesos aquí listados se pueden generar; el resto es informativo.
export const TIPOS_PODER: Record<string, TipoPoder> = {
  'EJECUTIVO SINGULAR': 'singular',
  'TRÁMITE PAGO DIRECTO': 'pago_directo',
};

// Procesos cuya DEMANDA sabe generar el motor. Se mantiene aparte de TIPOS_PODER
// porque las dos listas avanzan por separado: un proceso puede tener plantilla de
// poder mucho antes que generador de demanda, que es como estuvo el pago directo
// hasta ahora.
export const TIPOS_DEMANDA: Record<string, TipoPoder> = {
  'EJECUTIVO SINGULAR': 'singular',
  'TRÁMITE PAGO DIRECTO': 'pago_directo',
};

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
  generada: boolean; // ya tiene demanda en esta asignación
  // Solo llegan con ?insumos=1: qué tiene YA la persona en Drive. Cuesta una
  // consulta por cliente, por eso la lista normal no los trae.
  sac?: boolean;
  pagare?: boolean;
}

export const asignacionApi = {
  listar: () =>
    apiClient.get<{ asignaciones: AsignacionResumen[] }>('/asignaciones').then((r) => r.data.asignaciones),

  // Personas (cédula + nombre) de una asignación, para elegir a quién bajar del SAC.
  // `insumos` añade sac/pagare por persona (una consulta a Drive por cliente).
  personas: (id: string, insumos = false) =>
    apiClient
      .get<{ personas: AsignacionPersona[] }>(`/asignaciones/${id}/personas${insumos ? '?insumos=1' : ''}`)
      .then((r) => r.data.personas),

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
  // `tipo` decide EN QUÉ COLUMNA queda enlazado (poderUrl o poderPagoDirectoUrl) y
  // en qué carpeta se guarda. Sin él, el poder de un lote de pago directo acababa
  // en la del ejecutivo singular y la generación seguía diciendo que no hay poder.
  subirPoder: (id: string, poder: File, tipo: TipoPoder = 'singular') => {
    const form = new FormData();
    form.append('poderFile', poder);
    form.append('tipo', tipo);
    return apiClient
      .post<{ success: boolean; poderUrl: string; tipo: TipoPoder }>(`/asignaciones/${id}/poder`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },

  // Genera el Word combinado de poderes de una asignación. `cedulas` (opcional) =
  // subconjunto; vacío/omitido = todas las del tipo. `tipo` elige el proceso (y con
  // él la plantilla): ejecutivo singular o trámite de pago directo.
  generarPoderes: (id: string, docsEnServidor: boolean, cedulas?: string[], tipo: TipoPoder = 'singular') =>
    apiClient
      .post<GenerarPoderesResult>(
        `/asignaciones/${id}/generar-poderes`,
        { docsEnServidor, tipo, ...(cedulas && cedulas.length ? { cedulas } : {}) },
        { timeout: 3600000 },
      )
      .then((r) => r.data),

  // Genera las demandas de la asignación reusando el poder cacheado (segundo plano).
  // `cedulas` (opcional) = subconjunto a generar; vacío/omitido = todas las que el
  // motor acepte (solo ejecutivo singular). `correoPoder` (opcional) = PDF del correo
  // del banco para el ANEXO 1; si no se manda, se reusa el guardado en la asignación.
  // Lanza 409 { codigo: 'SIN_PODER' } si no hay poder enlazado.
  // `correoPoderRel` = uno de los correos que YA están en el servidor (lo normal);
  // `correoPoder` = subir un PDF nuevo, si aún no está guardado.
  generarDemandas: (id: string, cedulas?: string[], correoPoder?: File | null, correoPoderRel?: string) => {
    const form = new FormData();
    if (cedulas && cedulas.length) form.append('cedulas', JSON.stringify(cedulas));
    if (correoPoder) form.append('correoPoder', correoPoder);
    else if (correoPoderRel) form.append('correoPoderRel', correoPoderRel);
    return apiClient
      .post<{ success: boolean; started: boolean; message: string }>(
        `/asignaciones/${id}/generar-demandas`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      .then((r) => r.data);
  },

  // Solicitudes de aprehensión y entrega (trámite de pago directo). Va por su
  // propio endpoint, no por generarDemandas: los datos no salen del Excel sino de
  // los documentos que el banco deja en la carpeta de cada cliente.
  //
  // El correo del poder funciona igual que en el singular —se elige uno del
  // servidor o se sube— pero tiene que ser el de PAGO DIRECTO, así que la lista
  // se pide con ese proceso. A diferencia del singular NO se guarda en la
  // asignación: hay que elegirlo en cada generación.
  //
  // Responde 409 { codigo: 'SIN_PODER' } y 400 { codigo: 'SIN_CORREO_PODER' }.
  generarGarantias: (id: string, cedulas?: string[], correoPoder?: File | null, correoPoderRel?: string) => {
    const form = new FormData();
    if (cedulas && cedulas.length) form.append('cedulas', JSON.stringify(cedulas));
    if (correoPoder) form.append('correoPoder', correoPoder);
    else if (correoPoderRel) form.append('correoPoderRel', correoPoderRel);
    return apiClient
      .post<{ success: boolean; started: boolean; message: string }>(
        `/asignaciones/${id}/generar-garantias`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      .then((r) => r.data);
  },
};
