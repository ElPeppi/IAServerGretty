import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma/client';
import { EngineService } from '../../infrastructure/services/EngineService';
import { FileStorage } from '../../infrastructure/services/FileStorage';
import { fechaDesdeNombre, fechaCalendario } from '../../infrastructure/services/fechaAsignacion';
import { storage } from '../../infrastructure/storage';
import {
  RAIZ_DEMANDAS, detectarBanco, detectarAnio, carpetaAsignaciones, carpetaGarantias,
  carpetaPoderes, unir, type Proceso,
} from '../../infrastructure/storage/rutas';
import { hidratarCedula, limpiarLocalCedula, enParalelo } from '../../infrastructure/storage/sacSync';
import { carpetasDeCedula, relEnCarpetaCedula } from '../../infrastructure/storage/carpetasCedula';
import { sincronizarInsumos } from '../../infrastructure/storage/sincronizarInsumos';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { getSettings } from '../../infrastructure/config/settings';
import { EngineFile, EngineClientInfo, EngineDocument, TipoPoder } from '../../application/services/IEngineService';
import { correccionesDeCedulas } from '../../application/services/datosManuales';
import { AuthRequest } from '../middlewares/authMiddleware';

const engineService = new EngineService();
const fileStorage = new FileStorage();

// Un escaneo de asignaciones tarda minutos (una lectura de Drive y un mapeo del
// motor por Excel) y nginx corta la respuesta antes, así que el usuario tiende a
// volver a pulsar el botón. Sin candado, cada clic lanza un escaneo paralelo que
// repite TODO el trabajo y choca al insertar (unique en `nombre`). Basta una
// bandera en memoria: solo hay un proceso del backend.
let escaneoEnCurso = false;

// Generar un lote tarda minutos y el endpoint responde 202 de inmediato, así que
// nada impide que el usuario vuelva a pulsar y arranque un segundo lote sobre las
// MISMAS personas: trabajo duplicado, sesiones del SAC compitiendo y dos escrituras
// sobre el mismo Document. Se guarda por asignación.
const generacionEnCurso = new Set<string>();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Cédula reducida a dígitos, para comparar el Excel contra lo que guardó el motor. */
function soloDigitos(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

function fechaDMY(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function nombreLote(filename: string): string {
  return filename.replace(/\.(xlsx|xls|csv)$/i, '').trim();
}

// Parsea el Excel a filas (objetos por columna).
function parseFilas(buffer: Buffer): Array<Record<string, unknown>> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
}

// Cédulas del subconjunto a generar. Acepta el array de una petición JSON o el
// string (JSON o separado por comas) que llega cuando la petición es multipart.
function parseCedulas(raw: unknown): string[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = raw.split(/[,\s-]+/);
    }
  }
  return arr.map((c) => String(c).replace(/\D/g, '')).filter((c) => /^\d{5,12}$/.test(c));
}

// Persona consolidada (cédula única) a partir de las filas cacheadas del Excel.
export interface PersonaAsignacion { cedula: string; nombre: string; tipo: string }

// Mapeo canónico CAMPO → nombre de encabezado, resuelto por el MOTOR
// (heurística + Ollama). `null` = no se pudo → se usan los alias de abajo.
export type MapeoColumnas = Record<string, string> | null;

const mapeoCol = (mapeo: MapeoColumnas, campo: string): string | undefined => {
  const h = mapeo?.[campo];
  return h && typeof h === 'string' ? h : undefined;
};

// Columnas donde puede venir la cédula, en orden de preferencia. Los Excel del
// banco llegan con encabezados distintos en cada envío; los "crudos" traen la
// cédula en `ID` (por eso va de ÚLTIMA: es la menos específica y en otros
// formatos podría ser un consecutivo — se acepta solo si parece cédula).
const CED_COLS = ['IDENTIFICACION', 'IDENTIFICACIÓN', 'CEDULA', 'CÉDULA', 'DOCUMENTO', 'ID'];

// Cédula de una fila: la columna que dijo el mapeo del motor; si no hay mapeo (o
// esa columna viene vacía), la primera de CED_COLS cuyo valor tenga 5–12 dígitos.
// Sigue probando si la columna existe pero viene vacía o con basura ("----").
function cedulaDeFila(fila: Record<string, unknown>, mapeo: MapeoColumnas = null): string {
  const esCedula = (v: unknown): string => {
    if (v == null) return '';
    const digitos = String(v).replace(/\D/g, '');
    return /^\d{5,12}$/.test(digitos) ? digitos : '';
  };
  const delMapeo = mapeoCol(mapeo, 'IDENTIFICACION');
  if (delMapeo) {
    const hit = esCedula(fila[delMapeo]);
    if (hit) return hit;
  }
  for (const col of CED_COLS) {
    const hit = esCedula(fila[col]);
    if (hit) return hit;
  }
  return '';
}

// Deriva las personas (cédula + nombre + tipo de proceso) de las filas del Excel.
// Se usa tanto en el endpoint `personas` como al generar demandas una a una.
function personasDeFilas(
  filas: Array<Record<string, unknown>>,
  mapeo: MapeoColumnas = null,
): PersonaAsignacion[] {
  // Columnas de nombre en orden de preferencia. Los Excel de la oficina vienen
  // crudos (el motor mapea con LLM al generar), así que la de la persona suele
  // ser NOMBRE_CLIENTE; se dejan variantes por si el encabezado cambia.
  const NOM_COLS = [
    'NOMBRE_CLIENTE', 'NOMBRE CLIENTE', 'NOMBRE DEL CLIENTE',
    'NOMBRE', 'NOMBRES', 'NOMBRE COMPLETO', 'NOMBRE DEUDOR', 'DEUDOR', 'CLIENTE',
  ];
  const colNombre = mapeoCol(mapeo, 'NOMBRE');

  // Nombre de una fila: la columna del mapeo; si no, por lista de prioridad; si
  // no, cualquier columna con "NOMBRE" que NO sea de empresa/empleador (evita
  // NOMBRE EMPRESA TT).
  const nombreDeFila = (fila: Record<string, unknown>): string => {
    for (const col of colNombre ? [colNombre, ...NOM_COLS] : NOM_COLS) {
      const v = fila[col];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    for (const [k, v] of Object.entries(fila)) {
      const K = k.toUpperCase();
      if (K.includes('NOMBRE') && !/(EMPRESA|EMPLEAD|TT|BANCO|ARCHIVO)/.test(K)) {
        if (v != null && String(v).trim()) return String(v).trim();
      }
    }
    return '';
  };

  // Tipo de proceso de una fila. El esquema canónico del motor NO tiene campo de
  // proceso, así que aquí no ayuda el mapeo: se resuelve por nombre. Un mismo
  // Excel puede traer VARIAS columnas con "PROCESO" ("CLASE DE PROCESO",
  // "POSIBLE PROCESO JPS", "TIPO_PROCESO_JUDICIAL"…) → lista de prioridad
  // EXPLÍCITA y, solo al final, cualquier otra. Antes se tomaba "la primera que
  // apareciera", que dependía del orden de claves (Postgres jsonb las reordena).
  const PROC_COLS = [
    'POSIBLE PROCESO', 'POSIBLE PROCESO JPS', 'CLASE DE PROCESO',
    'CLASE DE PROCESO_GEN', 'TIPO_PROCESO_JUDICIAL', 'PROCESO',
  ];
  const tipoDeFila = (fila: Record<string, unknown>): string => {
    for (const col of PROC_COLS) {
      const v = fila[col];
      if (v != null && String(v).trim()) return normalizarTipo(String(v).trim());
    }
    for (const [k, v] of Object.entries(fila)) {
      if (/PROCESO/i.test(k) && v != null && String(v).trim()) return normalizarTipo(String(v).trim());
    }
    return normalizarTipo('');
  };

  // Una cédula puede tener varias filas con distinto proceso. Regla (igual que el
  // motor): es EJECUTIVO SINGULAR si AL MENOS una fila lo dice; si no, el primer
  // proceso no vacío que aparezca.
  const acumulado = new Map<string, { nombre: string; tipos: Set<string> }>();
  const orden: string[] = [];
  for (const fila of filas) {
    const cedula = cedulaDeFila(fila);
    if (!cedula) continue;
    if (!acumulado.has(cedula)) { acumulado.set(cedula, { nombre: nombreDeFila(fila), tipos: new Set() }); orden.push(cedula); }
    const acc = acumulado.get(cedula)!;
    if (!acc.nombre) acc.nombre = nombreDeFila(fila);
    acc.tipos.add(tipoDeFila(fila));
  }

  return orden.map((cedula) => {
    const { nombre, tipos } = acumulado.get(cedula)!;
    let tipo = 'SIN PROCESO';
    if (tipos.has('EJECUTIVO SINGULAR')) tipo = 'EJECUTIVO SINGULAR';
    else { for (const t of tipos) { if (t !== 'SIN PROCESO') { tipo = t; break; } } }
    return { cedula, nombre, tipo };
  });
}

// Etiqueta normalizada del tipo de proceso a partir del valor crudo del Excel.
// Solo EJECUTIVO SINGULAR lo genera el motor hoy; los demás son informativos.
function normalizarTipo(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return 'SIN PROCESO';
  if (/singu/i.test(s)) return 'EJECUTIVO SINGULAR';
  if (/restitu/i.test(s)) return 'RESTITUCIÓN';
  if (/pago\s*dir|tramit/i.test(s)) return 'TRÁMITE PAGO DIRECTO';
  return s.toUpperCase();
}

// Filas del Excel que traen cédula (columna CLIENTES de la lista). Usa la MISMA
// resolución de columna que `personasDeFilas`: antes miraba solo IDENTIFICACION,
// así que un Excel con la cédula en CEDULA/ID mostraba "0 clientes".
function contarCedulas(filas: Array<Record<string, unknown>>, mapeo: MapeoColumnas = null): number {
  let n = 0;
  for (const f of filas) if (cedulaDeFila(f, mapeo)) n++;
  return n;
}

// Lee el mapeo guardado en la asignación (columna Json `mapeo`) de forma segura.
function mapeoDe(asig: { mapeo?: unknown } | null | undefined): MapeoColumnas {
  const m = asig?.mapeo;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, string>) : null;
}

/**
 * Pregunta al MOTOR qué columna es cada campo (heurística + Ollama local, con
 * validación del contenido y caché por firma de encabezados). Devuelve el mapeo
 * por NOMBRE de encabezado — no por índice — porque las filas se guardan como
 * jsonb y Postgres no conserva el orden de las claves.
 *
 * Best-effort: si el motor está caído o no resuelve nada, devuelve null y todo
 * sigue funcionando con los alias por defecto (`CED_COLS`/`NOM_COLS`).
 */
// Encabezados que NUNCA pueden ser la cédula/nombre del DEUDOR aunque su
// contenido lo parezca: son otras partes del expediente. Red de seguridad ante
// un mapeo equivocado del motor — confundirlas demandaría a la persona errónea.
const NO_ES_DEUDOR = /(NEGOCIADOR|SUPERVISOR|CODEUDOR|EMPLEADOR|PATRONO|ABOGADO|COORDINADOR|ASESOR|EMPRESA)/i;

async function resolverMapeo(filas: Array<Record<string, unknown>>): Promise<MapeoColumnas> {
  if (!filas.length) return null;
  try {
    // Unión de claves: una fila suelta puede no traer todas las columnas.
    const headers: string[] = [];
    const vistos = new Set<string>();
    for (const f of filas.slice(0, 20)) {
      for (const k of Object.keys(f)) if (!vistos.has(k)) { vistos.add(k); headers.push(k); }
    }
    const muestra = filas.slice(0, 8).map((f) => headers.map((h) => f[h] ?? ''));
    const { porNombre } = await engineService.mapearColumnas({ headers, filas: muestra });
    if (!porNombre || !Object.keys(porNombre).length) return null;

    // Descarta los campos del DEUDOR si el motor apuntó a otra parte del proceso
    // (p. ej. IDENTIFICACION → "CEDULANEGOCIADOR"). Al quitarlos, `cedulaDeFila`
    // y `nombreDeFila` caen a sus alias, que sí son del deudor.
    const limpio: Record<string, string> = {};
    for (const [campo, header] of Object.entries(porNombre)) {
      if ((campo === 'IDENTIFICACION' || campo === 'NOMBRE') && NO_ES_DEUDOR.test(header)) {
        console.error(`[asignaciones] mapeo descartado: ${campo} → "${header}" (no es el deudor)`);
        continue;
      }
      limpio[campo] = header;
    }
    if (!Object.keys(limpio).length) return null;
    console.error(`[asignaciones] mapeo del motor: ${Object.entries(limpio).map(([c, h]) => `${c}→"${h}"`).join(', ')}`);
    return limpio;
  } catch (e) {
    console.error('[asignaciones] el motor no pudo mapear columnas:', e instanceof Error ? e.message : e);
    return null;
  }
}

export class AsignacionController {
  // POST /api/asignaciones  (multipart: excelFile) → cachea la asignación (NO genera demanda).
  async subir(req: AuthRequest, res: Response): Promise<void> {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ message: 'Archivo Excel requerido (campo: excelFile)' });
        return;
      }
      const filas = parseFilas(file.buffer);
      if (!filas.length) {
        res.status(400).json({ message: 'El Excel no contiene filas.' });
        return;
      }

      const nombre = nombreLote(file.originalname || 'ASIGNACION');
      const fecha =
        (req.body.fechaAsignacion ? new Date(req.body.fechaAsignacion as string) : null) ||
        fechaDesdeNombre(nombre);

      // Ruta DERIVADA del contenido: banco (de EMPRESA/NIT) + año (de la fecha/nombre)
      // → DEMANDAS/{banco}/ASIGNACION/{año}/{nombre}.xlsx. Así "Subir asignación" deja
      // el Excel en la MISMA carpeta que si alguien lo dejara a mano (misma convención).
      const banco = detectarBanco(filas);
      const anio = detectarAnio(fecha, nombre);
      const safeName = nombre.replace(/[^a-zA-Z0-9._-]/g, '_');
      const excelUrl = storage.enabled
        ? (await storage.save(unir(carpetaAsignaciones(banco, anio), `${nombre}.xlsx`), file.buffer, XLSX_MIME)).url
        : fileStorage.saveBuffer(file.buffer, `${safeName}.xlsx`, XLSX_MIME).url;

      // El MOTOR decide qué columna es qué (los encabezados cambian en cada
      // envío). Si no responde, `mapeo` queda null y se usan los alias.
      const mapeo = await resolverMapeo(filas);
      const mapeoJson = (mapeo ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull;

      const asignacion = await prisma.asignacion.upsert({
        where: { nombre },
        create: {
          nombre,
          fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : null,
          excelUrl,
          filas: filas as unknown as Prisma.InputJsonValue,
          mapeo: mapeoJson,
          totalFilas: contarCedulas(filas, mapeo),
          lawyerId: req.user!.userId,
        },
        update: {
          fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : undefined,
          excelUrl,
          filas: filas as unknown as Prisma.InputJsonValue,
          mapeo: mapeoJson,
          totalFilas: contarCedulas(filas, mapeo),
        },
      });

      res.status(201).json({ success: true, asignacion: this.resumen(asignacion) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al cachear la asignación';
      res.status(500).json({ message });
    }
  }

  // GET /api/asignaciones → lista (resumen + nº de poderes cacheados).
  async listar(req: AuthRequest, res: Response): Promise<void> {
    try {
      const items = await prisma.asignacion.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { poderes: true, documentos: true } } },
      });
      res.json({ asignaciones: items.map((a) => this.resumen(a)) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al listar asignaciones';
      res.status(500).json({ message });
    }
  }

  // GET /api/asignaciones/:id/personas → personas (cédula + nombre + tipo de proceso)
  // de la asignación, desde las filas cacheadas. Sirve para elegir a quién bajar del
  // SAC y para el selector de tipo de demanda (ejecutivo singular / restitución / …).
  async personas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const asignacion = await prisma.asignacion.findUnique({
        where: { id },
        select: { filas: true, mapeo: true },
      });
      if (!asignacion) {
        res.status(404).json({ message: 'Asignación no encontrada' });
        return;
      }
      const filas = (asignacion.filas as unknown as Array<Record<string, unknown>>) ?? [];
      const base = personasDeFilas(filas, mapeoDe(asignacion));

      // Quién tiene YA su demanda: una consulta, no una por persona. Se compara por
      // dígitos porque la cédula del Excel y la que devuelve el motor pueden venir
      // con puntos o ceros a la izquierda.
      const docs = await prisma.document.findMany({
        where: { asignacionId: id },
        select: { clientCedula: true },
      });
      const yaGeneradas = new Set(docs.map((d) => soloDigitos(d.clientCedula)).filter(Boolean));
      const personas = base.map((p) => ({ ...p, generada: yaGeneradas.has(soloDigitos(p.cedula)) }));

      // ?insumos=1 → además, qué tiene YA cada persona en el servidor (SAC y
      // pagaré). Es opcional porque cuesta una consulta por cliente: la lista
      // normal debe seguir siendo instantánea.
      if (String(req.query['insumos'] ?? '') === '1' && storage.enabled) {
        const banco = detectarBanco(filas);
        // En serie esto era una consulta a Drive tras otra: con 44 personas, quince
        // segundos antes de que el modal mostrara nada. Es pura espera de red, así
        // que se solapan con el mismo pool acotado que usa la hidratación.
        const conInsumos: Array<PersonaAsignacion & { generada: boolean; sac: boolean; pagare: boolean }> = [];
        await enParalelo(
          personas.map((p, i) => ({ p, i })),
          async ({ p, i }) => {
            const { sac, pagare } = await this.insumosSac(p.cedula, banco);
            conInsumos[i] = { ...p, sac, pagare };   // índice fijo: conserva el orden del Excel
          },
        );
        res.json({ personas: conInsumos });
        return;
      }

      res.json({ personas });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al listar personas';
      res.status(500).json({ message });
    }
  }

  // POST /api/asignaciones/actualizar → escanea ASIGNACIONES_DIR y agrega las que falten.
  async actualizar(req: AuthRequest, res: Response): Promise<void> {
    // Solo libera el candado quien lo tomó: si no, la petición que se va con 409
    // apagaría la bandera del escaneo que sigue corriendo.
    let candadoPropio = false;
    try {
      if (!storage.enabled) {
        res.status(400).json({ message: 'El almacenamiento no está configurado (revisa STORAGE_DRIVER y las credenciales).' });
        return;
      }
      if (escaneoEnCurso) {
        res.status(409).json({ message: 'Ya hay un escaneo en curso. Espera a que termine.' });
        return;
      }
      escaneoEnCurso = true;
      candadoPropio = true;
      // Recorre el árbol de la oficina: DEMANDAS/{banco}/ASIGNACION/{año}/*.xlsx
      // (o *.xlsx sueltos dentro de ASIGNACION). El BANCO y el AÑO salen de la RUTA
      // misma —no del contenido—: la carpeta donde alguien dejó el Excel dice a qué
      // banco/año pertenece. Se referencia el archivo EN SU carpeta (no se copia).
      const encontrados = await this.escanearAsignaciones();
      const existentes = new Set((await prisma.asignacion.findMany({ select: { nombre: true } })).map((a) => a.nombre));

      let agregadas = 0;
      const nuevas: string[] = [];
      for (const it of encontrados) {
        if (existentes.has(it.nombre)) continue;
        try {
          const buffer = await storage.read(it.relPath);
          const filas = parseFilas(buffer);
          if (!filas.length) continue;
          // Año: del nombre; si no, de la carpeta {año} donde está el archivo.
          const fecha = fechaDesdeNombre(it.nombre) || (it.anio ? fechaCalendario(Number(it.anio), 1, 1) : null);
          // Mismo mapeo del motor que en "subir": el drop manual trae los mismos
          // formatos cambiantes. El motor cachea por firma de encabezados, así que
          // un lote de Excel del mismo formato solo paga el mapeo una vez.
          const mapeo = await resolverMapeo(filas);
          await prisma.asignacion.create({
            data: {
              nombre: it.nombre,
              fechaAsignacion: fecha ?? null,
              // Referencia al archivo en su carpeta real (DEMANDAS/{banco}/ASIGNACION/{año}).
              excelUrl: storage.urlFor(it.relPath),
              filas: filas as unknown as Prisma.InputJsonValue,
              mapeo: (mapeo ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
              totalFilas: contarCedulas(filas, mapeo),
              lawyerId: req.user!.userId,
            },
          });
          agregadas++;
          nuevas.push(it.nombre);
          existentes.add(it.nombre);
        } catch (e) {
          // P2002 = ya existe una asignación con ese nombre. Con el candado no
          // debería pasar, pero si pasa NO es un error: ya está cacheada.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            existentes.add(it.nombre);
            continue;
          }
          console.error('[asignaciones/actualizar]', it.relPath, e instanceof Error ? e.message : e);
        }
      }
      res.json({ success: true, escaneadas: encontrados.length, agregadas, nuevas });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al actualizar asignaciones';
      res.status(500).json({ message });
    } finally {
      if (candadoPropio) escaneoEnCurso = false;
    }
  }

  /**
   * relPath del Word de poderes de una asignación:
   *   DEMANDAS/{banco}/{proceso}/PODERES/{año}/{nombre}.docx
   *
   * El PROCESO decide la rama del árbol: los poderes del ejecutivo singular van a
   * "EJECUTIVAS SINGULARES" y los del pago directo a "GARANTIA MOBILIARIAS", que
   * es donde la oficina guarda cada uno.
   *
   * Banco del contenido del Excel, año de la fecha de asignación (o del nombre).
   * El nombre lo pone el motor ("PODER PAGO DIRECTO {lote}.docx"), que es como se
   * llaman los históricos en esa carpeta; si no viene, se arma uno legible. Al
   * regenerar se sobreescribe el mismo archivo (`save` resuelve por ruta+nombre).
   */
  private relPoder(
    asignacion: { id: string; nombre: string; fechaAsignacion: Date | null; filas: unknown },
    filename?: string,
    proceso: Proceso = 'singular',
  ): string {
    const filas = (asignacion.filas as Array<Record<string, unknown>>) ?? [];
    const banco = detectarBanco(filas);
    const anio = detectarAnio(asignacion.fechaAsignacion, asignacion.nombre);
    const porDefecto = proceso === 'pago_directo'
      ? `PODER PAGO DIRECTO ${asignacion.nombre}.docx`
      : `PODERES EJECUTIVOS ${asignacion.nombre}.docx`;
    // Sin separadores de ruta: el nombre viene de fuera (motor o subida manual) y
    // no debe poder escaparse de la carpeta.
    const base = (filename || porDefecto).replace(/[\\/]+/g, '-').trim();
    const seguro = /\.docx$/i.test(base) ? base : `${base}.docx`;
    return unir(carpetaPoderes(banco, proceso), anio, seguro);
  }

  // Recorre DEMANDAS/{banco}/ASIGNACION/{año}/*.xlsx y devuelve los Excel hallados,
  // con su banco y año DEDUCIDOS DE LA RUTA. Acepta también *.xlsx sueltos dentro de
  // ASIGNACION (sin subcarpeta de año). Ignora temporales (~$) y no-Excel.
  private async escanearAsignaciones(): Promise<Array<{ relPath: string; nombre: string; banco: string; anio: string }>> {
    const out: Array<{ relPath: string; nombre: string; banco: string; anio: string }> = [];
    const esExcel = (n: string) => /\.(xlsx|xls)$/i.test(n) && !n.startsWith('~$');
    const bancos = await storage.list(RAIZ_DEMANDAS).catch(() => []);
    for (const banco of bancos) {
      const asigDir = unir(RAIZ_DEMANDAS, banco, 'ASIGNACION');
      const entradas = await storage.list(asigDir).catch(() => []);
      for (const e of entradas) {
        if (esExcel(e)) {
          // Excel suelto directamente en ASIGNACION (sin carpeta de año).
          out.push({ relPath: unir(asigDir, e), nombre: nombreLote(e), banco, anio: '' });
        } else {
          // Subcarpeta de año (2025, 2026, …) → sus Excel.
          const anio = e;
          const files = await storage.list(unir(asigDir, anio)).catch(() => []);
          for (const f of files) {
            if (esExcel(f)) out.push({ relPath: unir(asigDir, anio, f), nombre: nombreLote(f), banco, anio });
          }
        }
      }
    }
    return out;
  }

  // POST /api/asignaciones/:id/generar-poderes  { docsEnServidor } → Word combinado + cache Poder.
  async generarPoderes(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const asignacion = await prisma.asignacion.findUnique({ where: { id } });
      if (!asignacion) {
        res.status(404).json({ message: 'Asignación no encontrada' });
        return;
      }
      const docsEnServidor = !!req.body.docsEnServidor;
      // Tipo de poder: ejecutivo singular (por defecto) o trámite de pago directo
      // (garantía mobiliaria). Cambia la plantilla y a QUIÉN se le genera.
      const tipo: TipoPoder = req.body.tipo === 'pago_directo' ? 'pago_directo' : 'singular';
      const tipoProceso = tipo === 'pago_directo' ? 'TRÁMITE PAGO DIRECTO' : 'EJECUTIVO SINGULAR';
      const excel = await this.leerExcelOriginal(asignacion.excelUrl);
      if (!excel) {
        res.status(400).json({ message: 'No se pudo leer el Excel original de la asignación. Vuelve a subir la asignación.' });
        return;
      }
      // El poder usa su propia plantilla: se repone desde Drive igual que la demanda.
      await sincronizarInsumos();
      // Subconjunto de personas (vacío/omitido = todas las de proceso singular).
      const soloCedulas = parseCedulas(req.body.cedulas);

      // docsEnServidor: el motor lee el Nº de pagaré del DECEVAL/pagaré en la carpeta
      // del cliente EN SU DISCO. Con Drive como fuente, hay que BAJAR (hidratar) los
      // docs de cada cédula objetivo de Drive → local antes de correr el motor; si no,
      // el motor no los encuentra y excluye a todos ("sin documentos en el servidor").
      if (docsEnServidor && storage.enabled) {
        const filas = (asignacion.filas as unknown as Array<Record<string, unknown>>) ?? [];
        const banco = detectarBanco(filas);
        const objetivo = soloCedulas.length
          ? soloCedulas
          : personasDeFilas(filas, mapeoDe(asignacion)).filter((p) => p.tipo === tipoProceso).map((p) => p.cedula);
        for (const ced of objetivo) await hidratarCedula(ced, banco);
      }

      const result = await engineService.generarPoderes({
        excel,
        tipo,
        docsEnServidor,
        fechaAsignacion: asignacion.fechaAsignacion ? fechaDMY(asignacion.fechaAsignacion) : undefined,
        nombre: asignacion.nombre,
        smmv: getSettings().smmv,
        soloCedulas: soloCedulas.length ? soloCedulas : undefined,
        // Nº de pagaré capturado a mano: manda sobre el que lea el motor.
        correcciones: await correccionesDeCedulas(
          soloCedulas.length
            ? soloCedulas
            : personasDeFilas((asignacion.filas as unknown as Array<Record<string, unknown>>) ?? [], mapeoDe(asignacion))
                .filter((p) => p.tipo === tipoProceso).map((p) => p.cedula)
        ),
      });

      if (!result.success) {
        res.status(422).json({ message: result.error || 'No se pudieron generar los poderes', excluidos: result.excluidos });
        return;
      }

      // Guardar el Word combinado en la carpeta de la oficina:
      // DEMANDAS/{banco}/EJECUTIVAS SINGULARES/PODERES/{año}/{nombre}.docx — la
      // MISMA donde el motor lo deja en su disco y donde están los poderes
      // históricos. Antes iba a `_poderes/{id}.docx`: una carpeta suelta en la
      // raíz del Drive, con nombre de cuid, invisible para la oficina.
      let poderUrl: string | undefined;
      if (result.poderBase64) {
        const buf = Buffer.from(result.poderBase64, 'base64');
        poderUrl = storage.enabled
          ? (await storage.save(this.relPoder(asignacion, result.poderFilename, tipo), buf, DOCX_MIME)).url
          : fileStorage.saveBase64(result.poderBase64, result.poderFilename || `poderes-${asignacion.id}.docx`, DOCX_MIME).url;
      }

      // Reemplazar los poderes cacheados de esta asignación.
      // La generación tarda minutos (motor + Rama Judicial); al volver, el pool de
      // Postgres puede tener las conexiones ociosas recicladas y el `maxWait` por
      // defecto de Prisma (2s) se queda corto → "Unable to start a transaction in
      // the given time". Se dan tiempos amplios y un reintento para no perder el
      // Word ya generado por un tropiezo transitorio de conexión.
      const tipoPoder = tipo === 'pago_directo' ? 'PAGO_DIRECTO' : 'SINGULAR';
      const guardarCache = () =>
        prisma.$transaction(
          async (tx) => {
            // Solo se reemplazan los poderes DE ESTE TIPO: la misma asignación
            // puede tener ya generados los del otro proceso.
            await tx.poder.deleteMany({ where: { asignacionId: asignacion.id, tipo: tipoPoder } });
            await tx.poder.createMany({
              data: result.clientes.map((c) => ({
                asignacionId: asignacion.id,
                tipo: tipoPoder,
                cedula: c.cedula,
                nombre: c.nombre || null,
                ciudadJuzgado: c.ciudadJuzgado || null,
                tipoJuzgado: c.tipoJuzgado || null,
                numeroPagare: c.numeroPagare || c.pagare || null,
                pagareDesdeDocs: !!c.pagareDesdeDocs,
                placa: c.placa || null,
                marca: c.marca || null,
                modelo: c.modelo || null,
              })),
            });
            await tx.asignacion.update({
              where: { id: asignacion.id },
              data: tipo === 'pago_directo'
                ? { poderPagoDirectoUrl: poderUrl, poderPagoDirectoAt: new Date() }
                : { poderUrl, poderGeneradoAt: new Date(), docsEnServidor },
            });
          },
          { maxWait: 30000, timeout: 120000 },
        );

      try {
        await guardarCache();
      } catch (e) {
        console.error('[asignaciones/poderes] transacción falló, reintentando:', e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 1500));
        await guardarCache();
      }

      notificationHub.broadcast({
        type: 'generacion',
        level: 'success',
        title: 'Poderes generados',
        message: `${result.clientes.length} poder(es) para "${asignacion.nombre}"${result.excluidos.length ? `, ${result.excluidos.length} excluido(s)` : ''}.`,
        meta: { asignacionId: asignacion.id },
      });

      res.json({
        success: true,
        poderUrl,
        poderFilename: result.poderFilename,
        generados: result.clientes.length,
        excluidos: result.excluidos,
      });
    } catch (error: unknown) {
      const axiosCode = (error as { code?: string }).code;
      if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ENOTFOUND') {
        res.status(503).json({ message: 'El motor no está disponible. Verifica que sac_scripts esté corriendo.' });
        return;
      }
      const resp = (error as { response?: { data?: { error?: string; message?: string } } }).response;
      const message = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'Error al generar poderes');
      res.status(500).json({ message });
    }
  }

  // POST /api/asignaciones/:id/generar-demandas → genera las demandas de la asignación
  // REUSANDO el poder cacheado. Si no hay poder enlazado, responde 409 (el frontend
  // muestra el popup de "subir o generar"). Corre en segundo plano.
  async generarDemandas(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const asignacion = await prisma.asignacion.findUnique({ where: { id } });
      if (!asignacion) {
        res.status(404).json({ message: 'Asignación no encontrada' });
        return;
      }
      if (!asignacion.poderUrl) {
        res.status(409).json({ codigo: 'SIN_PODER', message: 'No hay poder enlazado a esta asignación.' });
        return;
      }
      if (generacionEnCurso.has(id)) {
        res.status(409).json({
          codigo: 'YA_EN_CURSO',
          message: 'Ya se están generando las demandas de esta asignación. Espera a que termine.',
        });
        return;
      }
      // Excel ORIGINAL (2 hojas) — el caché solo guarda Hoja1 y el motor necesita Hoja2.
      const excel = await this.leerExcelOriginal(asignacion.excelUrl);
      if (!excel) {
        res.status(400).json({ message: 'No se pudo leer el Excel original de la asignación. Vuelve a subir la asignación.' });
        return;
      }

      // Cédulas seleccionadas (subconjunto). Vacío/ausente = todas (las que el motor
      // acepte: solo ejecutivo singular). El motor filtra por proceso internamente.
      // La petición puede ser JSON (array) o multipart (string JSON) si trae el correo.
      const soloCedulas = parseCedulas(req.body.cedulas);

      // Correo del banco (PDF) → ANEXO 1. Si llega uno nuevo se guarda en el storage y
      // queda enlazado a la asignación; si no, se reusa el que ya tenga guardado.
      let correoPoderUrl = asignacion.correoPoderUrl;

      // `correoPoderRel`: uno de los que ya están en el servidor, elegido en la
      // web (ver GET /api/expedientes/_correos-poder). Tiene prioridad sobre el
      // guardado y evita tener que volver a subir el mismo PDF cada vez.
      const elegido = String(req.body?.correoPoderRel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (elegido && !req.file) {
        const basePoderes = carpetaPoderes(detectarBanco(
          (asignacion.filas as unknown as Array<Record<string, unknown>>) ?? [],
        ));
        // Solo se acepta si está DENTRO de la carpeta de poderes del banco.
        if (!elegido.startsWith(`${basePoderes}/`)) {
          res.status(400).json({ message: 'El correo elegido no está en la carpeta de poderes.' });
          return;
        }
        correoPoderUrl = storage.urlFor(elegido);
        await prisma.asignacion.update({ where: { id: asignacion.id }, data: { correoPoderUrl } });
      }

      if (req.file) {
        if (!storage.enabled) {
          res.status(400).json({ message: 'El almacenamiento no está configurado: no se puede guardar el correo del poder.' });
          return;
        }
        const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_') || 'correo_poder.pdf';
        correoPoderUrl = (await storage.save(`_asignaciones/${asignacion.id}/${Date.now()}-${safe}`, req.file.buffer, 'application/pdf')).url;
        await prisma.asignacion.update({ where: { id: asignacion.id }, data: { correoPoderUrl } });
      }
      // Sin el correo del poder la demanda saldría sin ANEXO 1 (el documento que
      // acredita el poder otorgado por el banco) → no se genera.
      const correoPoder = await this.leerArchivo(correoPoderUrl);
      if (!correoPoder) {
        res.status(400).json({
          codigo: 'SIN_CORREO_PODER',
          message: 'Adjunta el correo del banco que otorga el poder (PDF): es el ANEXO 1 de la demanda.',
        });
        return;
      }

      res.status(202).json({
        success: true,
        started: true,
        message: soloCedulas.length
          ? `Generación de ${soloCedulas.length} demanda(s) iniciada en segundo plano. Aparecerán en Documentos en unos minutos.`
          : 'Generación de demandas iniciada en segundo plano. Aparecerán en Documentos en unos minutos.',
      });

      notificationHub.broadcast({
        type: 'generacion',
        level: 'info',
        title: 'Generación de demandas iniciada',
        message: `Generando las demandas de "${asignacion.nombre}"…`,
        meta: { asignacionId: asignacion.id },
      });

      generacionEnCurso.add(asignacion.id);
      // Un void sin catch deja una promesa rechazada sin manejar, y eso MATA el
      // proceso en Node moderno: un error fuera del bucle (leer la asignación,
      // detectar el banco) se llevaría por delante el backend entero.
      void this.generarDemandasBg({
        asignacionId: asignacion.id,
        nombre: asignacion.nombre,
        excel,
        excelUrl: asignacion.excelUrl,
        correoPoder,
        fechaAsignacion: asignacion.fechaAsignacion,
        lawyerId: req.user!.userId,
        soloCedulas: soloCedulas.length ? soloCedulas : undefined,
      })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : 'error desconocido';
          console.error('[asignaciones/demandas] el lote se interrumpió:', msg);
          notificationHub.broadcast({
            type: 'generacion', level: 'error', title: 'La generación se interrumpió',
            message: `"${asignacion.nombre}": ${msg}`,
            meta: { asignacionId: asignacion.id },
          });
        })
        .finally(() => { generacionEnCurso.delete(asignacion.id); });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al generar demandas';
      res.status(500).json({ message });
    }
  }

  // Genera las demandas UNA A UNA: por cada persona corre el motor, persiste su
  // Document y notifica en el acto, de modo que aparezca en Documentos apenas está
  // lista (sin esperar al resto del lote). Antes de generar valida que la persona
  // tenga la info del SAC descargada; si no, la omite y avisa el motivo.
  private async generarDemandasBg(input: {
    asignacionId: string; nombre: string;
    excel: Buffer; excelUrl: string | null; correoPoder: Buffer | null;
    fechaAsignacion: Date | null; lawyerId: string;
    soloCedulas?: string[];
  }): Promise<void> {
    const t0 = Date.now();
    const fechaDMYStr = input.fechaAsignacion ? fechaDMY(input.fechaAsignacion) : undefined;

    // Antes de generar, repone desde Drive las plantillas y los certificados del
    // mes: son archivos de disco que el motor NO lee de Drive, y hasta ahora había
    // que copiarlos a mano. No lanza — si Drive falla, se genera con lo que haya.
    await sincronizarInsumos();

    // Lista objetivo: solo proceso ejecutivo singular (lo único que genera el
    // motor), intersectada con las cédulas elegidas en el modal (si las hay).
    const asig = await prisma.asignacion.findUnique({
      where: { id: input.asignacionId }, select: { filas: true, mapeo: true },
    });
    const filas = (asig?.filas as unknown as Array<Record<string, unknown>>) ?? [];
    // Banco de esta asignación (de EMPRESA/NIT) → define la carpeta GARANTIAS destino.
    const banco = detectarBanco(filas);
    let objetivo = personasDeFilas(filas, mapeoDe(asig)).filter((p) => p.tipo === 'EJECUTIVO SINGULAR');
    if (input.soloCedulas?.length) {
      const set = new Set(input.soloCedulas);
      objetivo = objetivo.filter((p) => set.has(p.cedula));
    }
    if (!objetivo.length) {
      notificationHub.broadcast({
        type: 'generacion', level: 'warning', title: 'Sin demandas para generar',
        message: `"${input.nombre}": no hay personas de proceso ejecutivo singular.`,
        meta: { asignacionId: input.asignacionId },
      });
      return;
    }

    notificationHub.broadcast({
      type: 'generacion', level: 'info', title: 'Generando demandas',
      message: `Generando ${objetivo.length} demanda(s) de "${input.nombre}", una por una…`,
      meta: { asignacionId: input.asignacionId, total: objetivo.length },
    });

    let generadas = 0, sinSac = 0, sinPagare = 0, omitidas = 0, fallidas = 0;

    for (const persona of objetivo) {
      const quien = `${persona.nombre || persona.cedula} (CC ${persona.cedula})`;

      // Requisitos (en Drive) para generar: SAC + pagaré. Si falta alguno, se ABORTA
      // esa demanda y se avisa el motivo específico; el resto del lote sigue.
      const insumos = await this.insumosSac(persona.cedula, banco);
      if (!insumos.sac) {
        sinSac++;
        notificationHub.broadcast({
          type: 'generacion', level: 'warning', title: 'Falta info del SAC',
          message: `No se generó la demanda de ${quien}: primero descarga su información del SAC.`,
          meta: { asignacionId: input.asignacionId, cedula: persona.cedula, motivo: 'sin_sac' },
        });
        continue;
      }
      if (!insumos.pagare) {
        sinPagare++;
        notificationHub.broadcast({
          type: 'generacion', level: 'warning', title: 'Falta el pagaré',
          message: `No se generó la demanda de ${quien}: falta el pagaré. Súbelo y vuelve a generar.`,
          meta: { asignacionId: input.asignacionId, cedula: persona.cedula, motivo: 'sin_pagare' },
        });
        continue;
      }

      try {
        // Drive es la fuente: bajamos la carpeta de la cédula al disco del motor para
        // que pueda leer los SAC y armar la demanda. Al terminar se borra (finally).
        await hidratarCedula(persona.cedula, banco);

        const result = await engineService.generateSingular({
          excel: input.excel,
          excelFilename: `${input.nombre}.xlsx`,
          // PDF del correo del banco → ANEXO 1 (el motor le sobrepone el poder .docx).
          correoPoder: input.correoPoder,
          correoPoderFilename: 'CORREO_PODER.pdf',
          fechaAsignacion: fechaDMYStr,
          smmv: getSettings().smmv,
          transito: getSettings().transito,
          soloCedulas: [persona.cedula],
          // Datos que el OCR no puede sacar del pagaré escaneado y se capturaron
          // a mano en el visor (nº de pagaré, fecha de suscripción).
          correcciones: await correccionesDeCedulas([persona.cedula]),
        });

        const doc = (result.documentos ?? [])[0];
        if (!doc) {
          // El motor la omitió (p. ej. pagaré no es certificado válido ni escaneado).
          omitidas++;
          const motivo = (result.omitidos ?? [])[0]?.motivo || 'el motor la omitió (revisa el pagaré)';
          notificationHub.broadcast({
            type: 'generacion', level: 'warning', title: 'Demanda no generada',
            message: `${quien}: ${motivo}.`,
            meta: { asignacionId: input.asignacionId, cedula: persona.cedula },
          });
          continue;
        }

        const info = (result.clientes ?? []).find((c) => c.cedula === doc.cedula);
        await this.persistirDemanda(doc, info, input, fechaDMYStr, banco);
        await this.reconciliarPoder(input.asignacionId, doc.cedula, doc.nombre, info);
        generadas++;

        // Aviso por demanda: es lo que la hace visible de una en Documentos.
        notificationHub.broadcast({
          type: 'generacion', level: 'success', title: 'Demanda lista',
          message: `Demanda de ${doc.nombre || quien} lista — ya puedes revisarla en Documentos.`,
          meta: { asignacionId: input.asignacionId, cedula: persona.cedula, hechas: generadas, total: objetivo.length },
        });
      } catch (error: unknown) {
        fallidas++;
        const resp = (error as { response?: { data?: { error?: string; message?: string } } }).response;
        const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'error');
        console.error(`[asignaciones/demandas] ${persona.cedula} FALLÓ:`, msg);
        notificationHub.broadcast({
          type: 'generacion', level: 'warning', title: 'Falló una demanda',
          message: `${quien}: ${String(msg)}`,
          meta: { asignacionId: input.asignacionId, cedula: persona.cedula },
        });
      } finally {
        // Drive es la fuente de verdad: se borra la copia local de la cédula tras generar.
        limpiarLocalCedula(persona.cedula);
      }
    }

    const segs = ((Date.now() - t0) / 1000).toFixed(0);
    console.error(`[asignaciones/demandas] FIN — ${generadas} generada(s), ${sinSac} sin SAC, ${sinPagare} sin pagaré, ${omitidas} omitida(s), ${fallidas} fallida(s) en ${segs}s`);
    const problemas = sinSac + sinPagare + omitidas + fallidas;
    notificationHub.broadcast({
      type: 'generacion',
      level: generadas ? (problemas ? 'warning' : 'success') : 'error',
      title: 'Generación de demandas terminada',
      message: `"${input.nombre}": ${generadas} generada(s)`
        + `${sinSac ? `, ${sinSac} sin info del SAC` : ''}`
        + `${sinPagare ? `, ${sinPagare} sin pagaré` : ''}`
        + `${omitidas ? `, ${omitidas} omitida(s)` : ''}`
        + `${fallidas ? `, ${fallidas} con error` : ''}.`,
      meta: { asignacionId: input.asignacionId, generadas, sinSac, sinPagare, omitidas, fallidas },
    });
  }

  // Revisa en Drive (`GARANTIAS/{cedula}`) los INSUMOS para generar la demanda:
  //  - sac:    hay SAC_*.pdf (antecedentes/correo). Se sube a Drive al descargar.
  //  - pagare: hay el PDF del pagaré. Regla espejo del motor (anexos.js): PDF que NO
  //            empieza por SAC_, NO es DATACREDITO, y el nombre tiene PAGARE o DECEVAL.
  // Una sola llamada a Drive. Sin storage no se puede verificar → no se bloquea.
  private async insumosSac(cedula: string, banco: string): Promise<{ sac: boolean; pagare: boolean }> {
    if (!storage.enabled) return { sac: true, pagare: true };
    try {
      // La carpeta del cliente puede llamarse "{cedula}", "{cedula}-AGOSTO 2026",
      // "CC {cedula}"… → se miran TODAS las que le correspondan (un cliente puede
      // tener el pagaré en la carpeta de una asignación y el SAC en la de otra).
      const carpetas = await carpetasDeCedula(String(cedula), banco);
      const archivos: string[] = [];
      for (const c of carpetas) archivos.push(...(await storage.list(c.relPath)));
      const sac = archivos.some((f) => /^SAC_.*\.pdf$/i.test(f));
      const pagare = archivos.some(
        (f) => /\.pdf$/i.test(f) && !/^SAC_/i.test(f) && !/DATACREDITO/i.test(f) && /(PAGARE|DECEVAL)/i.test(f),
      );
      return { sac, pagare };
    } catch {
      return { sac: false, pagare: false };
    }
  }

  // Persiste (crea o sobreescribe) el Document de una demanda. Una por (persona,
  // asignación): regenerar reemplaza la tarjeta existente; si hubo duplicados de
  // corridas viejas, conserva el más reciente y descarta el resto (no toca el NAS).
  private async persistirDemanda(
    doc: EngineDocument,
    info: EngineClientInfo | undefined,
    input: { asignacionId: string; excelUrl: string | null; lawyerId: string },
    fechaDMYStr: string | undefined,
    banco: string,
  ): Promise<void> {
    // Archivo del motor → storage: el motor escribe en SU disco y devuelve base64+relPath
    // ({cedula}/...). Se PREFIJA con la carpeta GARANTIAS del banco (DEMANDAS/{banco}/
    // EJECUTIVAS SINGULARES/GARANTIAS) —la raíz del storage es el top de la oficina— y se
    // sube ahí. Sin storage, copia el base64 al almacenamiento local (comportamiento previo).
    const subir = async (f?: EngineFile | null): Promise<{ url?: string; rel?: string }> => {
      if (!f) return {};
      if (storage.enabled && f.relPath) {
        const rel = await relEnCarpetaCedula(f.relPath, banco);
        if (f.base64) await storage.save(rel, Buffer.from(f.base64, 'base64'), f.mimeType);
        return { url: storage.urlFor(rel), rel };
      }
      return { url: fileStorage.saveBase64(f.base64, f.filename, f.mimeType).url };
    };

    // La demanda va primero y SOLA: `subir` usa storage.save, que crea la carpeta
    // del cliente si falta, y ese "buscar → crear" no tiene candado. Con la carpeta
    // ya creada, los otros dos se solapan sin riesgo de duplicarla. Son esperas de
    // red, no cómputo: en serie solo se suman latencias.
    const demanda = await subir(doc.archivos?.demanda);
    const [anexos, antecedentes] = await Promise.all([
      subir(doc.archivos?.anexos),
      subir(doc.archivos?.antecedentes),
    ]);
    const datos = {
      title: `Demanda Ejecutiva Singular — ${doc.nombre || doc.cedula}`,
      type: 'DEMANDA_SINGULAR',
      status: 'GENERATED' as const,
      clientName: doc.nombre || doc.cedula,
      clientCedula: doc.cedula,
      fileUrl: demanda.url,
      anexosUrl: anexos.url,
      antecedentesUrl: antecedentes.url,
      // El visor lee asignacionUrl (pestaña "Asignación") y "Regenerar" lo exige
      // para releer el Excel: el asignacionId solo sirve de FK.
      asignacionUrl: input.excelUrl ?? undefined,
      asignacionId: input.asignacionId,
      notes: (doc.notas ?? []) as unknown as Prisma.InputJsonValue,
      metadata: {
        numeroPagare: info?.numeroPagare,
        // Ruta YA prefijada (GARANTIAS/{cedula}/...) → la usan firma y editor.
        demandaRelPath: demanda.rel ?? doc.archivos?.demanda?.relPath,
        fechaAsignacion: fechaDMYStr ?? null,
      } as Prisma.InputJsonValue,
    };

    const previos = await prisma.document.findMany({
      where: { asignacionId: input.asignacionId, clientCedula: doc.cedula },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (previos.length) {
      await prisma.document.update({ where: { id: previos[0]!.id }, data: datos });
      const sobrantes = previos.slice(1).map((p) => p.id);
      if (sobrantes.length) {
        await prisma.document.deleteMany({ where: { id: { in: sobrantes } } });
        console.error(`[asignaciones/demandas] ${doc.cedula}: ${sobrantes.length} duplicado(s) descartado(s)`);
      }
    } else {
      await prisma.document.create({ data: { ...datos, lawyerId: input.lawyerId } });
    }
  }

  // Reconcilia el poder cacheado de un cliente contra los datos de la demanda.
  // La demanda MANDA: si difiere nombre/ciudad/pagaré, se corrige el poder.
  private async reconciliarPoder(
    asignacionId: string, cedula: string, nombreDemanda: string, info?: EngineClientInfo
  ): Promise<void> {
    try {
      const poder = await prisma.poder.findFirst({ where: { asignacionId, cedula } });
      if (!poder) return;
      const cambios: Prisma.PoderUpdateInput = {};
      const nombre = (nombreDemanda || info?.nombre || '').trim();
      if (nombre && nombre !== (poder.nombre || '').trim()) cambios.nombre = nombre;
      if (info?.ciudad && info.ciudad.trim() !== (poder.ciudadJuzgado || '').trim()) cambios.ciudadJuzgado = info.ciudad.trim();
      if (info?.tipoJuzgadoFinal && info.tipoJuzgadoFinal.trim() !== (poder.tipoJuzgado || '').trim()) cambios.tipoJuzgado = info.tipoJuzgadoFinal.trim();
      if (info?.numeroPagare && String(info.numeroPagare).trim() !== (poder.numeroPagare || '').trim()) cambios.numeroPagare = String(info.numeroPagare).trim();
      if (Object.keys(cambios).length) {
        await prisma.poder.update({ where: { id: poder.id }, data: cambios });
        console.error(`[asignaciones/demandas] poder ${cedula} reconciliado:`, Object.keys(cambios).join(', '));
      }
    } catch (e) {
      console.error(`[asignaciones/demandas] reconciliar poder ${cedula}:`, e instanceof Error ? e.message : e);
    }
  }

  // POST /api/asignaciones/:id/poder  (multipart: poderFile) → enlaza un Word de poderes ya hecho.
  async subirPoder(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const file = req.file;
      if (!file) {
        res.status(400).json({ message: 'Archivo Word requerido (campo: poderFile)' });
        return;
      }
      const asignacion = await prisma.asignacion.findUnique({ where: { id } });
      if (!asignacion) {
        res.status(404).json({ message: 'Asignación no encontrada' });
        return;
      }
      // Misma carpeta que el poder generado por el motor (ver `relPoder`): el que
      // se sube a mano no tiene por qué acabar en otro sitio.
      const poderUrl = storage.enabled
        ? (await storage.save(this.relPoder(asignacion, file.originalname), file.buffer, DOCX_MIME)).url
        : fileStorage.saveBuffer(file.buffer, `poderes-${asignacion.id}.docx`, DOCX_MIME).url;

      await prisma.asignacion.update({
        where: { id: asignacion.id },
        data: { poderUrl, poderGeneradoAt: new Date() },
      });
      res.json({ success: true, poderUrl });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al subir el poder';
      res.status(500).json({ message });
    }
  }

  // Lee el Excel ORIGINAL de la asignación (guardado en excelUrl al subirla/escanearla).
  // Se usa el original —no las filas cacheadas— porque el motor necesita AMBAS hojas:
  // Hoja1 (maestros) + Hoja2 (financieros: capital/interés/obligaciones → cuantía).
  // El caché solo guarda Hoja1, así que reconstruir desde `filas` perdería Hoja2.
  private leerExcelOriginal(excelUrl: string | null): Promise<Buffer | null> {
    return this.leerArchivo(excelUrl);
  }

  // Lee un archivo guardado por el backend a partir de la URL persistida: primero
  // desde el storage (/docs) y, como respaldo, desde uploads/ (instalaciones sin storage).
  private async leerArchivo(url: string | null): Promise<Buffer | null> {
    if (!url) return null;
    try {
      const rel = storage.relPathFromUrl(url);
      if (storage.enabled && rel) return await storage.read(rel);
      const m = url.match(/\/uploads\/([^/?#]+)$/);
      if (m) {
        const p = path.join(process.cwd(), 'uploads', decodeURIComponent(m[1]));
        if (fs.existsSync(p)) return fs.readFileSync(p);
      }
    } catch (e) {
      console.error('[asignaciones] no se pudo leer el archivo:', url, e instanceof Error ? e.message : e);
    }
    return null;
  }

  // Forma resumida para la UI.
  private resumen(a: {
    id: string; nombre: string; fechaAsignacion: Date | null; totalFilas: number;
    poderUrl: string | null; poderGeneradoAt: Date | null; docsEnServidor: boolean;
    correoPoderUrl?: string | null;
    createdAt: Date; _count?: { poderes: number; documentos: number };
  }) {
    return {
      id: a.id,
      nombre: a.nombre,
      fechaAsignacion: a.fechaAsignacion,
      totalFilas: a.totalFilas,
      tienePoder: !!a.poderUrl,
      poderUrl: a.poderUrl,
      poderGeneradoAt: a.poderGeneradoAt,
      docsEnServidor: a.docsEnServidor,
      correoPoderUrl: a.correoPoderUrl ?? null,
      poderesCacheados: a._count?.poderes ?? 0,
      demandas: a._count?.documentos ?? 0,
      // Pendientes = clientes del Excel que aún NO tienen demanda. Se DERIVA de los
      // Document existentes en vez de llevar un contador: `persistirDemanda` solo
      // corre cuando la generación salió bien (y deduplica por cédula), así que un
      // fallo no descuenta nada y el número no se puede desincronizar.
      demandasPendientes: Math.max(0, a.totalFilas - (a._count?.documentos ?? 0)),
      createdAt: a.createdAt,
    };
  }
}
