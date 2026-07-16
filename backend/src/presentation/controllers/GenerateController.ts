import { Response } from 'express';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { prisma } from '../../infrastructure/database/prisma/client';
import { getSettings } from '../../infrastructure/config/settings';
import { N8nService } from '../../infrastructure/services/N8nService';
import { EngineService } from '../../infrastructure/services/EngineService';
import { FileStorage } from '../../infrastructure/services/FileStorage';
import { NasStorage } from '../../infrastructure/services/NasStorage';
import { notificationHub } from '../../infrastructure/services/NotificationHub';
import { EngineFile } from '../../application/services/IEngineService';
import { AuthRequest } from '../middlewares/authMiddleware';

const documentRepository = new PrismaDocumentRepository();
const userRepository = new PrismaUserRepository();
const n8nService = new N8nService();
const engineService = new EngineService();
const fileStorage = new FileStorage();
const nas = new NasStorage();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Saca las cédulas del Excel de asignación (columna IDENTIFICACION; con respaldos
// por si el encabezado varía). Solo dígitos, únicas. El motor valida/normaliza.
function extraerCedulasDeExcel(buffer: Buffer): string[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  const COLS = ['IDENTIFICACION', 'IDENTIFICACIÓN', 'CEDULA', 'CÉDULA', 'DOCUMENTO'];
  const out = new Set<string>();
  for (const row of rows) {
    for (const col of COLS) {
      if (row[col] == null) continue;
      const ced = String(row[col]).replace(/\D/g, '');
      if (/^\d{5,12}$/.test(ced)) out.add(ced);
      break; // primera columna que exista en la fila
    }
  }
  return [...out];
}

export class GenerateController {
  async fromExcel(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ message: 'Archivo Excel requerido' });
        return;
      }

      const lawyer = await userRepository.findById(req.user!.userId);
      if (!lawyer) {
        res.status(404).json({ message: 'Abogado no encontrado' });
        return;
      }

      // Parse Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

      if (rows.length === 0) {
        res.status(400).json({ message: 'El Excel no contiene datos' });
        return;
      }

      // Build client info from first row (or from body)
      const firstRow = rows[0];
      const clientName =
        (req.body.clientName as string) ||
        (firstRow['Cliente'] as string) ||
        (firstRow['CLIENTE'] as string) ||
        (firstRow['client_name'] as string) ||
        'Cliente sin nombre';

      const clientRfc =
        (req.body.clientRfc as string) ||
        (firstRow['RFC'] as string) ||
        (firstRow['Rfc'] as string) ||
        undefined;

      const templateType = (req.body.templateType as string) ?? 'DEMANDA_CIVIL';

      // Call n8n to generate the document
      const result = await n8nService.generateDemand({
        lawyerId: lawyer.id,
        lawyerName: lawyer.name,
        clientName,
        clientRfc,
        excelData: rows,
        templateType,
      });

      // Create document record
      const document = await documentRepository.create({
        title: result.title,
        type: templateType,
        clientName,
        clientRfc,
        fileUrl: result.fileUrl,
        lawyerId: lawyer.id,
        metadata: { excelRows: rows.length, templateType },
      });

      await documentRepository.update(document.id, { status: 'GENERATED' });

      res.status(201).json({ success: true, documentId: document.id });
    } catch (error: unknown) {
      // Detect n8n connectivity issues and return a clear message
      const axiosCode = (error as { code?: string }).code;
      const httpStatus = (error as { response?: { status?: number } }).response?.status;

      if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ENOTFOUND') {
        res.status(503).json({ message: 'n8n no está disponible. Verifica que el contenedor esté corriendo.' });
        return;
      }
      if (httpStatus === 404) {
        res.status(503).json({ message: 'El workflow de n8n no está activo. Importa y activa "generar-demanda.json" en http://localhost:5678' });
        return;
      }

      const message = error instanceof Error ? error.message : 'Error al generar demanda';
      res.status(500).json({ message });
    }
  }

  /**
   * Genera demandas SINGULARES con el motor real (sac_scripts).
   * Campos (multipart): excelFile (obligatorio), correoPoder (opcional, PDF del
   * banco para el ANEXO 1), fechaAsignacion (opcional).
   * Crea un Document por cliente, con demanda + anexos + antecedentes + asignación
   * y las notas de procedencia.
   */
  async singular(req: AuthRequest, res: Response): Promise<void> {
    const files = req.files as
      | { [field: string]: Express.Multer.File[] }
      | undefined;
    const excelFile  = files?.['excelFile']?.[0];
    const correoFile = files?.['correoPoder']?.[0];

    if (!excelFile) {
      res.status(400).json({ message: 'Archivo Excel requerido (campo: excelFile)' });
      return;
    }
    const lawyer = await userRepository.findById(req.user!.userId);
    if (!lawyer) {
      res.status(404).json({ message: 'Abogado no encontrado' });
      return;
    }

    // Responder de INMEDIATO: la generación corre en SEGUNDO PLANO. Los lotes
    // grandes tardan varios minutos (scraping por cliente) y excederían el
    // timeout del navegador. Las demandas aparecen en Documentos al terminar.
    res.status(202).json({
      success: true,
      started: true,
      message: 'Generación iniciada en segundo plano. Las demandas aparecerán en Documentos en unos minutos.',
    });

    // Avisar a todos los logueados que arrancó la generación.
    notificationHub.broadcast({
      type: 'generacion',
      level: 'info',
      title: 'Generación iniciada',
      message: `${lawyer.name} inició la generación de demandas${excelFile.originalname ? ` (${excelFile.originalname})` : ''}.`,
      meta: { lote: excelFile.originalname || null, lawyerId: lawyer.id },
    });

    // No se hace await: el trabajo continúa tras enviar la respuesta.
    void this.generarEnSegundoPlano({
      excel: excelFile.buffer,
      excelFilename: excelFile.originalname,
      correoPoder: correoFile?.buffer ?? null,
      correoPoderFilename: correoFile?.originalname,
      fechaAsignacion: (req.body.fechaAsignacion as string) || undefined,
      smmv: getSettings().smmv,
      transito: getSettings().transito,
      lawyerId: lawyer.id,
      lote: excelFile.originalname || null,
    });
  }

  /**
   * Descarga las obligaciones del SAC por CÉDULA (reemplaza el disparo por ZIP/n8n).
   * Recibe cédulas separadas por "-", "," o espacios; el motor corre el scraping
   * (Puppeteer) y deja SAC_*.pdf + CONTACTOS_*.csv en la carpeta de cada cliente.
   * Síncrono (con timeout alto): el SAC tarda por cédula y corre secuencial.
   */
  async descargarSac(req: AuthRequest, res: Response): Promise<void> {
    try {
      // Cédulas de dos fuentes (combinables): texto pegado + Excel de asignación.
      const pegadas = String(req.body?.cedulas ?? '').trim();
      const delExcel = req.file ? extraerCedulasDeExcel(req.file.buffer) : [];

      // El motor normaliza y deduplica; aquí solo unimos ambas fuentes.
      const cedulas = [pegadas, ...delExcel].filter(Boolean).join(' ');
      if (!cedulas.trim()) {
        res.status(400).json({
          message: req.file
            ? 'El Excel no tiene cédulas en la columna IDENTIFICACION.'
            : 'Ingresa al menos una cédula (separadas por "-", "," o espacios) o sube el Excel de asignación.',
        });
        return;
      }

      const result = await engineService.descargarSac({ cedulas });
      res.status(200).json(result);
    } catch (error: unknown) {
      const axiosCode = (error as { code?: string }).code;
      if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ENOTFOUND') {
        res.status(503).json({ message: 'El motor no está disponible. Verifica que sac_scripts esté corriendo.' });
        return;
      }
      const resp = (error as { response?: { data?: { error?: string; message?: string } } }).response;
      const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'Error al descargar del SAC');
      res.status(500).json({ message: String(msg) });
    }
  }

  /**
   * Regenera UNA sola demanda ya existente: vuelve a correr el motor con el Excel
   * de asignación original, filtrado a la cédula de este documento, y SOBREESCRIBE
   * el mismo Document (no crea uno nuevo). Corre en segundo plano; la vista se
   * refresca al llegar la notificación de "generación terminada".
   *
   * Nota: no se reusa el "correo del poder" del lote original (no se persiste), por
   * lo que el ANEXO 1 (poder) puede quedar sin el correo del banco sobrepuesto.
   */
  async regenerarUno(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = req.params['id'] as string;
      const document = await documentRepository.findById(id);
      if (!document) {
        res.status(404).json({ message: 'Documento no encontrado' });
        return;
      }
      const isOwner = document.lawyerId === req.user?.userId;
      const isAdmin = req.user?.role === 'ADMIN';
      if (!isOwner && !isAdmin) {
        res.status(403).json({ message: 'Sin permiso para regenerar este documento' });
        return;
      }
      if (document.status === 'SIGNED') {
        res.status(409).json({ message: 'La demanda ya está firmada; no se puede regenerar' });
        return;
      }
      if (!document.clientCedula) {
        res.status(400).json({ message: 'El documento no tiene cédula: no se puede regenerar' });
        return;
      }
      if (!document.asignacionUrl) {
        res.status(400).json({ message: 'No se guardó el Excel de asignación de esta demanda: no se puede regenerar' });
        return;
      }

      // Recuperar el Excel de asignación desde el NAS.
      let excel: Buffer;
      try {
        const rel = nas.relPathFromUrl(document.asignacionUrl);
        if (!nas.enabled || !rel) throw new Error('asignación fuera del NAS');
        excel = fs.readFileSync(nas.absFromRelPath(rel));
      } catch {
        res.status(400).json({ message: 'No se pudo leer el Excel de asignación en el NAS' });
        return;
      }

      res.status(202).json({
        success: true,
        started: true,
        message: 'Regeneración iniciada en segundo plano. La demanda se actualizará en unos momentos.',
      });

      const meta = (document.metadata ?? {}) as { fechaAsignacion?: string | null };
      notificationHub.broadcast({
        type: 'generacion',
        level: 'info',
        title: 'Regeneración iniciada',
        message: `Regenerando la demanda de ${document.clientName || document.clientCedula}…`,
        meta: { documentId: document.id, cedula: document.clientCedula },
      });

      void this.regenerarEnSegundoPlano({
        documentId: document.id,
        cedula: document.clientCedula,
        clientName: document.clientName || document.clientCedula,
        excel,
        fechaAsignacion: meta.fechaAsignacion ?? undefined,
        smmv: getSettings().smmv,
        transito: getSettings().transito,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al regenerar';
      res.status(500).json({ message });
    }
  }

  // Corre el motor para UNA cédula y sobreescribe el Document existente. Segundo plano.
  private async regenerarEnSegundoPlano(input: {
    documentId: string; cedula: string; clientName: string;
    excel: Buffer; fechaAsignacion?: string; smmv?: number;
    transito?: Array<{ ciudad: string; entidad: string; correo: string }>;
  }): Promise<void> {
    const t0 = Date.now();
    try {
      const result = await engineService.generateSingular({
        excel: input.excel,
        excelFilename: 'regeneracion.xlsx',
        fechaAsignacion: input.fechaAsignacion,
        smmv: input.smmv,
        transito: input.transito,
        soloCedulas: [input.cedula],
      });

      const doc = (result.documentos ?? []).find((d) => d.cedula === input.cedula);
      if (!doc) {
        // El motor no la generó esta vez (p. ej. pagaré ya no válido): avisar y dejar el doc como estaba.
        const motivo = (result.omitidos ?? []).find((o) => o.cedula === input.cedula)?.motivo
          || 'el motor no devolvió la demanda';
        notificationHub.broadcast({
          type: 'generacion',
          level: 'warning',
          title: 'No se regeneró la demanda',
          message: `${input.clientName}: ${motivo}.`,
          meta: { documentId: input.documentId, cedula: input.cedula },
        });
        return;
      }

      const fileRef = (f?: EngineFile | null): string | undefined => {
        if (!f) return undefined;
        if (nas.enabled && f.relPath) return nas.urlForRelPath(f.relPath);
        return fileStorage.saveBase64(f.base64, f.filename, f.mimeType).url;
      };

      await documentRepository.update(input.documentId, {
        status: 'GENERATED',
        fileUrl: fileRef(doc.archivos?.demanda),
        anexosUrl: fileRef(doc.archivos?.anexos),
        antecedentesUrl: fileRef(doc.archivos?.antecedentes),
        notes: doc.notas ?? [],
      });

      console.error(`[GENERATE/regenerar] OK — ${input.cedula} en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      notificationHub.broadcast({
        type: 'generacion',
        level: 'success',
        title: 'Demanda regenerada',
        message: `Se regeneró la demanda de ${input.clientName}.`,
        meta: { documentId: input.documentId, cedula: input.cedula },
      });
    } catch (error: unknown) {
      const resp = (error as { response?: { data?: { error?: string; message?: string } } }).response;
      const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'error');
      console.error('[GENERATE/regenerar] FALLÓ:', msg);
      notificationHub.broadcast({
        type: 'generacion',
        level: 'error',
        title: 'Falló la regeneración',
        message: `${input.clientName}: ${String(msg)}`,
        meta: { documentId: input.documentId, cedula: input.cedula },
      });
    }
  }

  // Guarda las OBSERVACIONES (clientes para los que NO se generó la demanda y por qué).
  private async persistObservaciones(
    lawyerId: string,
    lote: string | null,
    omitidos: Array<{ cedula?: string; nombre?: string; motivo?: string }>
  ): Promise<void> {
    if (!omitidos?.length) return;
    try {
      await prisma.observacion.createMany({
        data: omitidos.map((o) => ({
          cedula: String(o.cedula ?? ''),
          nombre: o.nombre || null,
          motivo: o.motivo || 'No se generó la demanda',
          lote,
          lawyerId,
        })),
      });
    } catch (e) {
      console.error('[GENERATE/singular] no se pudieron guardar observaciones:', e);
    }
  }

  // Llama al motor (puede tardar minutos), guarda los Document por cliente y las
  // observaciones. Corre desacoplado de la respuesta HTTP (segundo plano).
  private async generarEnSegundoPlano(input: {
    excel: Buffer; excelFilename?: string;
    correoPoder: Buffer | null; correoPoderFilename?: string;
    fechaAsignacion?: string; smmv?: number;
    transito?: Array<{ ciudad: string; entidad: string; correo: string }>;
    lawyerId: string; lote: string | null;
  }): Promise<void> {
    const t0 = Date.now();
    try {
      const result = await engineService.generateSingular({
        excel: input.excel,
        excelFilename: input.excelFilename || 'entrada.xlsx',
        correoPoder: input.correoPoder,
        correoPoderFilename: input.correoPoderFilename,
        fechaAsignacion: input.fechaAsignacion,
        smmv: input.smmv,
        transito: input.transito,
      });

      // Almacenamiento: SOLO el NAS (ni S3 ni disco del servidor). Si DOCS_DIR
      // está configurado y el motor devolvió la ruta relativa, se referencia el
      // archivo en el NAS (/docs); si no, se cae al respaldo local (uploads/).
      const safeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, '_');
      const asignacionUrl = nas.enabled
        ? nas.saveBuffer(
            input.excel,
            `_asignaciones/${input.lawyerId}/${Date.now()}-${safeName(input.excelFilename || 'asignacion.xlsx')}`
          )
        : fileStorage.saveBuffer(input.excel, input.excelFilename || 'asignacion.xlsx', XLSX_MIME).url;

      // Referencia de un archivo del motor: preferir el NAS (relPath); si no hay
      // NAS configurado, copiar el base64 al almacenamiento local (comportamiento previo).
      const fileRef = (f?: EngineFile | null): string | undefined => {
        if (!f) return undefined;
        if (nas.enabled && f.relPath) return nas.urlForRelPath(f.relPath);
        return fileStorage.saveBase64(f.base64, f.filename, f.mimeType).url;
      };

      let creados = 0;
      for (const doc of result.documentos ?? []) {
        await documentRepository.create({
          title: `Demanda Ejecutiva Singular — ${doc.nombre || doc.cedula}`,
          type: 'DEMANDA_SINGULAR',
          status: 'GENERATED',
          clientName: doc.nombre || doc.cedula,
          clientCedula: doc.cedula,
          fileUrl: fileRef(doc.archivos?.demanda),
          anexosUrl: fileRef(doc.archivos?.anexos),
          antecedentesUrl: fileRef(doc.archivos?.antecedentes),
          asignacionUrl,
          notes: doc.notas ?? [],
          lawyerId: input.lawyerId,
          metadata: {
            numeroPagare: (result.clientes ?? []).find((c) => c.cedula === doc.cedula)?.numeroPagare,
            // Ruta del .docx en el NAS → la usa el editor para sobreescribir el archivo.
            demandaRelPath: doc.archivos?.demanda?.relPath,
            // Se guarda para poder REGENERAR la demanda con la misma fecha de asignación.
            fechaAsignacion: input.fechaAsignacion ?? null,
          },
        });
        creados++;
      }
      await this.persistObservaciones(input.lawyerId, input.lote, result.omitidos ?? []);
      const omit = (result.omitidos ?? []).length;
      console.error(`[GENERATE/singular] segundo plano OK — ${creados} generada(s), ${omit} omitida(s) en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      notificationHub.broadcast({
        type: 'generacion',
        level: 'success',
        title: 'Generación de demandas terminada',
        message: `${creados} demanda(s) generada(s)${omit ? `, ${omit} omitida(s) (ver Observaciones)` : ''}.`,
        meta: { creados, omitidos: omit, lote: input.lote },
      });
    } catch (error: unknown) {
      const resp = (error as {
        response?: { status?: number; data?: {
          error?: string; message?: string;
          omitidos?: Array<{ cedula?: string; nombre?: string; motivo?: string }>;
        } };
      }).response;
      if (resp?.data?.omitidos?.length) {
        // El motor procesó pero omitió a todos (p. ej. sin pagaré): guardar las observaciones.
        await this.persistObservaciones(input.lawyerId, input.lote, resp.data.omitidos);
        const omit = resp.data.omitidos.length;
        console.error('[GENERATE/singular] segundo plano: 0 generadas,', omit, 'omitida(s) —', resp.data.error || resp.data.message);
        notificationHub.broadcast({
          type: 'generacion',
          level: 'warning',
          title: 'Generación terminada sin demandas',
          message: `0 generadas, ${omit} omitida(s) (ver Observaciones).`,
          meta: { creados: 0, omitidos: omit, lote: input.lote },
        });
      } else {
        const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'error');
        console.error('[GENERATE/singular] segundo plano FALLÓ:', msg);
        notificationHub.broadcast({
          type: 'generacion',
          level: 'error',
          title: 'Falló la generación de demandas',
          message: String(msg),
          meta: { lote: input.lote },
        });
      }
    }
  }
}
