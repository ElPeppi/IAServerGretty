import { Response } from 'express';
import * as XLSX from 'xlsx';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { PrismaUserRepository } from '../../infrastructure/database/prisma/UserRepository';
import { prisma } from '../../infrastructure/database/prisma/client';
import { getSettings } from '../../infrastructure/config/settings';
import { N8nService } from '../../infrastructure/services/N8nService';
import { EngineService } from '../../infrastructure/services/EngineService';
import { FileStorage } from '../../infrastructure/services/FileStorage';
import { NasStorage } from '../../infrastructure/services/NasStorage';
import { EngineFile } from '../../application/services/IEngineService';
import { AuthRequest } from '../middlewares/authMiddleware';

const documentRepository = new PrismaDocumentRepository();
const userRepository = new PrismaUserRepository();
const n8nService = new N8nService();
const engineService = new EngineService();
const fileStorage = new FileStorage();
const nas = new NasStorage();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
          },
        });
        creados++;
      }
      await this.persistObservaciones(input.lawyerId, input.lote, result.omitidos ?? []);
      console.error(`[GENERATE/singular] segundo plano OK — ${creados} generada(s), ${(result.omitidos ?? []).length} omitida(s) en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
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
        console.error('[GENERATE/singular] segundo plano: 0 generadas,', resp.data.omitidos.length, 'omitida(s) —', resp.data.error || resp.data.message);
      } else {
        const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'error');
        console.error('[GENERATE/singular] segundo plano FALLÓ:', msg);
      }
    }
  }
}
