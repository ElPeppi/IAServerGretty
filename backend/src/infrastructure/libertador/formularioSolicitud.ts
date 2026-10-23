/**
 * formularioSolicitud.ts — Formulario de Google "Datos del siniestro" con el que
 * se le piden a Seguros Bolívar los documentos de una solicitud de Libertador
 * (poder subrogado, declaración de pago, póliza, reconocer).
 *
 * El formulario NO pide iniciar sesión: el correo es un campo que escribe quien
 * responde, y a ese correo le llega la copia de la respuesta. Por eso se envía
 * con un POST directo a /formResponse, sin navegador ni cuenta de Google.
 *
 * Las preguntas se reconocen por su TÍTULO (sin tildes ni mayúsculas), no por su
 * id: así el mismo código sirve para el formulario real y para una copia de
 * prueba. Y si Bolívar agrega una pregunta obligatoria que no conocemos, no se
 * manda nada a medias: falla diciendo cuál es.
 *
 * Config (backend/.env):
 *   LIBERTADOR_FORM_URL            enlace …/viewform. Vacío = no se envía nada.
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
}

export interface Formulario {
  id: string;
  titulo: string;
  accion: string;
  paginas: number;
  preguntas: Pregunta[];
  correo: 'ninguno' | 'escrito' | 'verificado';
  fbzx: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const valorEnv = (k: string, porDefecto: string) => (process.env[k] ?? '').trim() || porDefecto;

export function configFormulario() {
  return {
    url: (process.env.LIBERTADOR_FORM_URL || '').trim(),
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
  // El tipo 8 es un salto de página.
  const preguntas: Pregunta[] = items
    .filter((it) => Array.isArray(it[4]) && (it[4] as unknown[]).length)
    .map((it) => {
      const e = (it[4] as unknown[][])[0];
      return {
        titulo: String(it[1] ?? ''),
        entrada: Number(e[0]),
        opciones: ((e[1] as unknown[][]) || []).map((o) => String(o[0])),
        obligatoria: e[2] === 1,
      };
    });

  // f[10][6]: cómo recoge el correo. 2 = verificado (exige sesión de Google),
  // 3 = lo escribe quien responde. Comprobado contra el formulario real (3) y la
  // copia de prueba con "correos verificados" (2).
  const modo = Array.isArray(f[10]) ? f[10][6] : null;
  const correo = modo === 2 ? 'verificado' : modo === 3 || /name="emailAddress"/.test(html) ? 'escrito' : 'ninguno';

  return {
    id,
    titulo: (html.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() || id,
    accion: `https://docs.google.com/forms/d/e/${id}/formResponse`,
    paginas: items.filter((it) => it[3] === 8).length + 1,
    preguntas,
    correo,
    fbzx: (html.match(/name="fbzx" value="([^"]+)"/) || [])[1] || '',
  };
}

/** Respuesta del formulario como pares (nombre, valor) del POST. Lanza si algo no cuadra. */
export function armarRespuesta(form: Formulario, d: DatosFormulario, cfg = configFormulario()): Array<[string, string]> {
  if (form.correo === 'verificado') {
    throw new Error('El formulario recoge el correo VERIFICADO: exige iniciar sesión con Google y no se puede enviar automático.');
  }
  const pares: Array<[string, string]> = [];
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

/** Envía la respuesta. Lanza si Google no la registró. */
export async function enviarFormulario(form: Formulario, pares: Array<[string, string]>): Promise<void> {
  const body = new URLSearchParams(pares);
  body.append('fvv', '1');
  // Todas las páginas de una vez: se le dice a Google que se recorrieron todas.
  body.append('pageHistory', Array.from({ length: form.paginas }, (_, i) => i).join(','));
  if (form.fbzx) body.append('fbzx', form.fbzx);

  const res = await axios.post<string>(form.accion, body.toString(), {
    responseType: 'text',
    timeout: 30000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    validateStatus: () => true,
  });
  const html = String(res.data || '');
  if (res.status >= 400) throw new Error(`Google respondió HTTP ${res.status} al enviar el formulario.`);
  // Cuando la acepta, Google pinta la confirmación (con el enlace "Enviar otra
  // respuesta", usp=form_confirm). Si algún campo no le gustó, vuelve a pintar el
  // formulario, que trae otra vez su FB_PUBLIC_LOAD_DATA_.
  if (/FB_PUBLIC_LOAD_DATA_/.test(html) && !/form_confirm/.test(html)) {
    throw new Error('Google devolvió el formulario sin registrar la respuesta: algún campo no le gustó.');
  }
}

/** Texto legible de lo enviado, para dejarlo en la carpeta del caso. */
export function textoDelEnvio(form: Formulario, pares: Array<[string, string]>, cuando = new Date()): string {
  const titulos = new Map(form.preguntas.map((p) => [`entry.${p.entrada}`, p.titulo.split('\n')[0]]));
  const porCampo = new Map<string, string[]>();
  for (const [k, v] of pares) porCampo.set(k, [...(porCampo.get(k) || []), v]);
  const fecha = cuando.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const lineas = [...porCampo].map(([k, vs]) => `  ${k === 'emailAddress' ? 'Correo electrónico' : titulos.get(k) || k}: ${vs.join(' | ')}`);
  return [`Formulario "${form.titulo}" (${form.id})`, `Enviado: ${fecha}`, ...lineas, ''].join('\n');
}
