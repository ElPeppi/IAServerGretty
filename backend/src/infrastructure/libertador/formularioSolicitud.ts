/**
 * formularioSolicitud.ts — Formulario de Google "Datos del siniestro" con el que
 * se le piden a Seguros Bolívar los documentos de una solicitud de Libertador
 * (poder subrogado, declaración de pago, póliza, reconocer).
 *
 * NO se envía solo: el botón "Enviar" de la última página tiene reCAPTCHA
 * (invisible para una persona en un navegador, pero un POST directo recibe 400) y
 * no se esquiva. Lo que hace el sistema es armar el ENLACE PRELLENADO
 * (viewform?usp=pp_url&…) con todas las respuestas; una persona lo abre, revisa,
 * da Siguiente y Enviar. Abierto sin sesión de Google (incógnito) trae también el
 * correo; con sesión, Google deja el correo vacío y hay que escribirlo.
 *
 * Las preguntas se reconocen por su TÍTULO (sin tildes ni mayúsculas), no por su
 * id: así el mismo código sirve para el formulario real y para una copia de
 * prueba. Y si Bolívar agrega una pregunta obligatoria que no conocemos, no se
 * arma un enlace a medias: falla diciendo cuál es.
 *
 * Config (backend/.env), todo opcional:
 *   LIBERTADOR_FORM_URL            enlace …/viewform (por defecto, el de Bolívar). "off" = no se arma.
 *   LIBERTADOR_FORM_CORREO         correo del abogado
 *   LIBERTADOR_FORM_ABOGADO        nombres y apellidos, en MAYÚSCULA
 *   LIBERTADOR_FORM_DESPACHO       nombre del despacho judicial
 *   LIBERTADOR_FORM_DOCUMENTOS     documentos a marcar, separados por ";"
 *   LIBERTADOR_FORM_OBSERVACIONES  observaciones adicionales
 */
import axios from 'axios';

export interface DatosFormulario {
  solicitud: string;
  poliza: string;
  estado: string;   // el del siniestro en el Huella; tiene que ser una opción del formulario
  ciudad: string;   // Ciudad de Residencia del arrendatario
}

interface Pregunta {
  titulo: string;
  entrada: number;
  opciones: string[];   // vacío = respuesta de texto
  obligatoria: boolean;
  pagina: number;       // 0 = primera; los saltos de sección separan páginas
}

export interface Formulario {
  id: string;
  titulo: string;
  vista: string;        // …/viewform
  accion: string;       // …/formResponse
  paginas: number;
  preguntas: Pregunta[];
  correo: 'ninguno' | 'escrito' | 'verificado';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const valorEnv = (k: string, porDefecto: string) => (process.env[k] ?? '').trim() || porDefecto;

// Formulario "Datos del siniestro" de Seguros Bolívar (Libertador).
const FORM_BOLIVAR = 'https://docs.google.com/forms/d/e/1FAIpQLSfTIxr-lU3sAUbnkk3a1G0O7AWcf6PCGslJ5usOfa0ltEd9zg/viewform';

export function configFormulario() {
  const url = valorEnv('LIBERTADOR_FORM_URL', FORM_BOLIVAR);
  return {
    url: /^(off|no|0|false)$/i.test(url) ? '' : url,
    correo: valorEnv('LIBERTADOR_FORM_CORREO', 'jramos@jramosabogado.com'),
    abogado: valorEnv('LIBERTADOR_FORM_ABOGADO', 'JAIRO ENRIQUE RAMOS LAZARO'),
    despacho: valorEnv('LIBERTADOR_FORM_DESPACHO', 'PEQUEÑAS CAUSAS Y COMPETENCIAS MULTIPLES'),
    documentos: valorEnv('LIBERTADOR_FORM_DOCUMENTOS', 'Poder Ejecutivo Subrogado;Declaración de pago;Póliza;Reconocer')
      .split(';').map((s) => s.trim()).filter(Boolean),
    observaciones: valorEnv('LIBERTADOR_FORM_OBSERVACIONES', 'DECLARACION DE PAGO SUBROGADA ACTUALIZADA'),
  };
}

export const formularioActivo = () => !!configFormulario().url;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Lee la estructura del formulario desde su página pública (FB_PUBLIC_LOAD_DATA_). */
export async function leerFormulario(url: string): Promise<Formulario> {
  const m = url.match(/\/forms\/d\/e\/([^/?#]+)/);
  if (!m) throw new Error(`No es un enlace de Google Forms (…/forms/d/e/<id>/viewform): ${url}`);
  const id = m[1];

  const res = await axios.get<string>(`https://docs.google.com/forms/d/e/${id}/viewform`, {
    responseType: 'text',
    timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9' },
  });
  const final: string = res.request?.res?.responseUrl || '';
  if (/accounts\.google\.com/.test(final)) {
    throw new Error('El formulario exige iniciar sesión con Google: así no se puede enviar automático.');
  }
  const html = String(res.data || '');
  const dm = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*([\s\S]*?);\s*<\/script>/);
  if (!dm) throw new Error('No pude leer la estructura del formulario (la página no trae FB_PUBLIC_LOAD_DATA_).');
  const data = JSON.parse(dm[1]);
  const f = data[1] || [];
  const items: unknown[][] = f[1] || [];

  // Cada pregunta: [id, título, descripción, tipo, [[idEntrada, opciones, obligatoria, …]], …].
  // El tipo 8 es un salto de sección: lo que viene después va en la página siguiente.
  const preguntas: Pregunta[] = [];
  let pagina = 0;
  for (const it of items) {
    if (it[3] === 8) { pagina++; continue; }
    if (!Array.isArray(it[4]) || !(it[4] as unknown[]).length) continue;
    const e = (it[4] as unknown[][])[0];
    preguntas.push({
      titulo: String(it[1] ?? ''),
      entrada: Number(e[0]),
      opciones: ((e[1] as unknown[][]) || []).map((o) => String(o[0])),
      obligatoria: e[2] === 1,
      pagina,
    });
  }

  // f[10][6]: cómo recoge el correo. 2 = verificado (exige sesión de Google),
  // 3 = lo escribe quien responde. Comprobado contra el formulario real (3) y la
  // copia de prueba con "correos verificados" (2).
  const modo = Array.isArray(f[10]) ? f[10][6] : null;
  const correo = modo === 2 ? 'verificado' : modo === 3 || /name="emailAddress"/.test(html) ? 'escrito' : 'ninguno';

  return {
    id,
    titulo: (html.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() || id,
    vista: `https://docs.google.com/forms/d/e/${id}/viewform`,
    accion: `https://docs.google.com/forms/d/e/${id}/formResponse`,
    paginas: pagina + 1,
    preguntas,
    correo,
  };
}

/** Respuestas como pares (nombre, valor) del enlace prellenado. Lanza si algo no cuadra. */
export function armarRespuesta(form: Formulario, d: DatosFormulario, cfg = configFormulario()): Array<[string, string]> {
  const pares: Array<[string, string]> = [];
  // Con correo "verificado" lo pone Google desde la cuenta de quien lo abre: no va en el enlace.
  if (form.correo === 'escrito') pares.push(['emailAddress', cfg.correo]);

  const problemas: string[] = [];
  for (const p of form.preguntas) {
    const t = norm(p.titulo);
    let valores: string[] | null = null;
    if (/^correo/.test(t)) valores = [cfg.correo];
    else if (/poliza/.test(t)) valores = [d.poliza];
    else if (/\bsolicitud\b/.test(t)) valores = [d.solicitud];
    else if (/estado del siniestro/.test(t)) valores = [d.estado];
    else if (/nombres? y apellidos?/.test(t)) valores = [cfg.abogado];
    else if (/nombre (del )?despacho/.test(t)) valores = [cfg.despacho];
    else if (/ciudad/.test(t)) valores = [d.ciudad];
    else if (/documentos a solicitar/.test(t)) valores = cfg.documentos;
    else if (/observaciones/.test(t)) valores = [cfg.observaciones];

    if (!valores) {
      if (p.obligatoria) problemas.push(`"${p.titulo}" es obligatoria y no sé qué poner`);
      continue;
    }
    valores = valores.map((v) => String(v ?? '').trim()).filter(Boolean);
    if (!valores.length) {
      if (p.obligatoria) problemas.push(`falta el dato de "${p.titulo}"`);
      continue;
    }

    if (p.opciones.length) {
      // Opción única o casillas: Google solo acepta el texto exacto de una opción.
      for (const v of valores) {
        const o = p.opciones.find((x) => norm(x) === norm(v));
        if (o) pares.push([`entry.${p.entrada}`, o]);
        else problemas.push(`"${v}" no es una opción de "${p.titulo}" (${p.opciones.join(', ')})`);
      }
    } else {
      pares.push([`entry.${p.entrada}`, valores[0]]);
    }
  }
  if (problemas.length) throw new Error(`No se puede llenar el formulario: ${problemas.join('; ')}.`);
  return pares;
}

/** Enlace del formulario con todas las respuestas puestas (Google lo llama "prellenado"). */
export function enlacePrellenado(form: Formulario, pares: Array<[string, string]>): string {
  return `${form.vista}?usp=pp_url&${new URLSearchParams(pares).toString()}`;
}

/**
 * Las respuestas, legibles. Va al registro que se deja en la carpeta del caso
 * cuando alguien marca el formulario como enviado. Lleva el id del formulario:
 * es lo que se busca para no volver a ofrecer el mismo formulario a esa solicitud.
 */
export function textoDeRespuestas(form: Formulario, pares: Array<[string, string]>): string {
  const titulos = new Map(form.preguntas.map((p) => [`entry.${p.entrada}`, p.titulo.split('\n')[0]]));
  const porCampo = new Map<string, string[]>();
  for (const [k, v] of pares) porCampo.set(k, [...(porCampo.get(k) || []), v]);
  const lineas = [...porCampo].map(([k, vs]) => `  ${k === 'emailAddress' ? 'Correo electrónico' : titulos.get(k) || k}: ${vs.join(' | ')}`);
  return [`Formulario "${form.titulo}" (${form.id})`, ...lineas].join('\n');
}
