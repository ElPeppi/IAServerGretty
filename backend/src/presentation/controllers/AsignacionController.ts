import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma/client';
import { EngineService } from '../../infrastructure/services/EngineService';
import { FileStorage } from '../../infrastructure/services/FileStorage';
import { storage } from '../../infrastructure/storage';
import {
  RAIZ_DEMANDAS, detectarBanco, detectarAnio, carpetaAsignaciones, carpetaGarantias, unir,
} from '../../infrastructure/storage/rutas';
import { hidratarCedula, limpiarLocalCedula } from '../../infrastructure/storage/sacSync';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { getSettings } from '../../infrastructure/config/settings';
import { EngineFile, EngineClientInfo, EngineDocument } from '../../application/services/IEngineService';
import { AuthRequest } from '../middlewares/authMiddleware';

const engineService = new EngineService();
const fileStorage = new FileStorage();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// "11 DE JUNIO DE 2026", "31 MARZO 2026", "(30 ENERO 2026)", "10 julio 2026" →
// Date. El "de" es opcional (los Excel de la oficina lo omiten). null si no matchea.
function fechaDesdeNombre(nombre: string): Date | null {
  const m = nombre
    .toLowerCase()
    .match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\s+(?:de\s+)?(\d{4})/i);
  if (!m) return null;
  const dia = parseInt(m[1], 10);
  const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
  const anio = parseInt(m[3], 10);
  if (!mes || dia < 1 || dia > 31) return null;
  return new Date(anio, mes - 1, dia);
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

// Deriva las personas (cédula + nombre + tipo de proceso) de las filas del Excel.
// Se usa tanto en el endpoint `personas` como al generar demandas una a una.
function personasDeFilas(filas: Array<Record<string, unknown>>): PersonaAsignacion[] {
  const CED_COLS = ['IDENTIFICACION', 'IDENTIFICACIÓN', 'CEDULA', 'CÉDULA', 'DOCUMENTO'];
  // Columnas de nombre en orden de preferencia. Los Excel de la oficina vienen
  // crudos (el motor mapea con LLM al generar), así que la de la persona suele
  // ser NOMBRE_CLIENTE; se dejan variantes por si el encabezado cambia.
  const NOM_COLS = [
    'NOMBRE_CLIENTE', 'NOMBRE CLIENTE', 'NOMBRE DEL CLIENTE',
    'NOMBRE', 'NOMBRES', 'NOMBRE COMPLETO', 'NOMBRE DEUDOR', 'DEUDOR', 'CLIENTE',
  ];

  // Nombre de una fila: primero por lista de prioridad; si no, cualquier columna
  // que contenga "NOMBRE" y NO sea de empresa/empleador (evita NOMBRE EMPRESA TT).
  const nombreDeFila = (fila: Record<string, unknown>): string => {
    for (const col of NOM_COLS) {
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

  // Tipo de proceso de una fila: la columna que contenga "PROCESO" (el encabezado
  // varía: "POSIBLE PROCESO", "PROCESO"…) → etiqueta normalizada.
  const tipoDeFila = (fila: Record<string, unknown>): string => {
    let raw = '';
    for (const [k, v] of Object.entries(fila)) {
      if (/PROCESO/i.test(k) && v != null && String(v).trim()) { raw = String(v).trim(); break; }
    }
    return normalizarTipo(raw);
  };

  const cedulaDeFila = (fila: Record<string, unknown>): string => {
    for (const col of CED_COLS) {
      if (fila[col] == null) continue;
      return String(fila[col]).replace(/\D/g, '');
    }
    return '';
  };

  // Una cédula puede tener varias filas con distinto proceso. Regla (igual que el
  // motor): es EJECUTIVO SINGULAR si AL MENOS una fila lo dice; si no, el primer
  // proceso no vacío que aparezca.
  const acumulado = new Map<string, { nombre: string; tipos: Set<string> }>();
  const orden: string[] = [];
  for (const fila of filas) {
    const cedula = cedulaDeFila(fila);
    if (!/^\d{5,12}$/.test(cedula)) continue;
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

function contarCedulas(filas: Array<Record<string, unknown>>): number {
  let n = 0;
  for (const f of filas) if (String(f['IDENTIFICACION'] ?? '').trim()) n++;
  return n;
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

      const asignacion = await prisma.asignacion.upsert({
        where: { nombre },
        create: {
          nombre,
          fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : null,
          excelUrl,
          filas: filas as unknown as Prisma.InputJsonValue,
          totalFilas: contarCedulas(filas),
          lawyerId: req.user!.userId,
        },
        update: {
          fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : undefined,
          excelUrl,
          filas: filas as unknown as Prisma.InputJsonValue,
          totalFilas: contarCedulas(filas),
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
        select: { filas: true },
      });
      if (!asignacion) {
        res.status(404).json({ message: 'Asignación no encontrada' });
        return;
      }
      const filas = (asignacion.filas as unknown as Array<Record<string, unknown>>) ?? [];
      res.json({ personas: personasDeFilas(filas) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al listar personas';
      res.status(500).json({ message });
    }
  }

  // POST /api/asignaciones/actualizar → escanea ASIGNACIONES_DIR y agrega las que falten.
  async actualizar(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!storage.enabled) {
        res.status(400).json({ message: 'El almacenamiento no está configurado (revisa STORAGE_DRIVER y las credenciales).' });
        return;
      }
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
          const fecha = fechaDesdeNombre(it.nombre) || (it.anio ? new Date(Number(it.anio), 0, 1) : null);
          await prisma.asignacion.create({
            data: {
              nombre: it.nombre,
              fechaAsignacion: fecha ?? null,
              // Referencia al archivo en su carpeta real (DEMANDAS/{banco}/ASIGNACION/{año}).
              excelUrl: storage.urlFor(it.relPath),
              filas: filas as unknown as Prisma.InputJsonValue,
              totalFilas: contarCedulas(filas),
              lawyerId: req.user!.userId,
            },
          });
          agregadas++;
          nuevas.push(it.nombre);
          existentes.add(it.nombre);
        } catch (e) {
          console.error('[asignaciones/actualizar]', it.relPath, e instanceof Error ? e.message : e);
        }
      }
      res.json({ success: true, escaneadas: encontrados.length, agregadas, nuevas });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al actualizar asignaciones';
      res.status(500).json({ message });
    }
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
      const excel = await this.leerExcelOriginal(asignacion.excelUrl);
      if (!excel) {
        res.status(400).json({ message: 'No se pudo leer el Excel original de la asignación. Vuelve a subir la asignación.' });
        return;
      }
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
          : personasDeFilas(filas).filter((p) => p.tipo === 'EJECUTIVO SINGULAR').map((p) => p.cedula);
        for (const ced of objetivo) await hidratarCedula(ced, banco);
      }

      const result = await engineService.generarPoderes({
        excel,
        docsEnServidor,
        fechaAsignacion: asignacion.fechaAsignacion ? fechaDMY(asignacion.fechaAsignacion) : undefined,
        nombre: asignacion.nombre,
        smmv: getSettings().smmv,
        soloCedulas: soloCedulas.length ? soloCedulas : undefined,
      });

      if (!result.success) {
        res.status(422).json({ message: result.error || 'No se pudieron generar los poderes', excluidos: result.excluidos });
        return;
      }

      // Guardar el Word combinado bajo /docs para poder servirlo/descargarlo.
      let poderUrl: string | undefined;
      if (result.poderBase64) {
        const buf = Buffer.from(result.poderBase64, 'base64');
        poderUrl = storage.enabled
          ? (await storage.save(`_poderes/${asignacion.id}.docx`, buf, DOCX_MIME)).url
          : fileStorage.saveBase64(result.poderBase64, result.poderFilename || `poderes-${asignacion.id}.docx`, DOCX_MIME).url;
      }

      // Reemplazar los poderes cacheados de esta asignación.
      // La generación tarda minutos (motor + Rama Judicial); al volver, el pool de
      // Postgres puede tener las conexiones ociosas recicladas y el `maxWait` por
      // defecto de Prisma (2s) se queda corto → "Unable to start a transaction in
      // the given time". Se dan tiempos amplios y un reintento para no perder el
      // Word ya generado por un tropiezo transitorio de conexión.
      const guardarCache = () =>
        prisma.$transaction(
          async (tx) => {
            await tx.poder.deleteMany({ where: { asignacionId: asignacion.id } });
            await tx.poder.createMany({
              data: result.clientes.map((c) => ({
                asignacionId: asignacion.id,
                cedula: c.cedula,
                nombre: c.nombre || null,
                ciudadJuzgado: c.ciudadJuzgado || null,
                tipoJuzgado: c.tipoJuzgado || null,
                numeroPagare: c.numeroPagare || c.pagare || null,
                pagareDesdeDocs: !!c.pagareDesdeDocs,
              })),
            });
            await tx.asignacion.update({
              where: { id: asignacion.id },
              data: { poderUrl, poderGeneradoAt: new Date(), docsEnServidor },
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
      if (req.file) {
        if (!storage.enabled) {
          res.status(400).json({ message: 'El almacenamiento no está configurado: no se puede guardar el correo del poder.' });
          return;
        }
        const safe = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_') || 'correo_poder.pdf';
        correoPoderUrl = (await storage.save(`_asignaciones/${asignacion.id}/${Date.now()}-${safe}`, req.file.buffer, 'application/pdf')).url;
        await prisma.asignacion.update({ where: { id: asignacion.id }, data: { correoPoderUrl } });
      }
      const correoPoder = await this.leerArchivo(correoPoderUrl);

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

      void this.generarDemandasBg({
        asignacionId: asignacion.id,
        nombre: asignacion.nombre,
        excel,
        excelUrl: asignacion.excelUrl,
        correoPoder,
        fechaAsignacion: asignacion.fechaAsignacion,
        lawyerId: req.user!.userId,
        soloCedulas: soloCedulas.length ? soloCedulas : undefined,
      });
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

    // Lista objetivo: solo proceso ejecutivo singular (lo único que genera el
    // motor), intersectada con las cédulas elegidas en el modal (si las hay).
    const asig = await prisma.asignacion.findUnique({
      where: { id: input.asignacionId }, select: { filas: true },
    });
    const filas = (asig?.filas as unknown as Array<Record<string, unknown>>) ?? [];
    // Banco de esta asignación (de EMPRESA/NIT) → define la carpeta GARANTIAS destino.
    const banco = detectarBanco(filas);
    let objetivo = personasDeFilas(filas).filter((p) => p.tipo === 'EJECUTIVO SINGULAR');
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
      const archivos = await storage.list(unir(carpetaGarantias(banco), String(cedula)));
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
        const rel = unir(carpetaGarantias(banco), f.relPath);
        if (f.base64) await storage.save(rel, Buffer.from(f.base64, 'base64'), f.mimeType);
        return { url: storage.urlFor(rel), rel };
      }
      return { url: fileStorage.saveBase64(f.base64, f.filename, f.mimeType).url };
    };

    const demanda = await subir(doc.archivos?.demanda);
    const anexos = await subir(doc.archivos?.anexos);
    const antecedentes = await subir(doc.archivos?.antecedentes);
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
      const poderUrl = storage.enabled
        ? (await storage.save(`_poderes/${asignacion.id}.docx`, file.buffer, DOCX_MIME)).url
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
      createdAt: a.createdAt,
    };
  }
}
