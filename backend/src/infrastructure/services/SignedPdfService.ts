/**
 * SignedPdfService — arma el PDF FINAL de la demanda firmada y lo guarda en el NAS.
 *
 * Al firmar, la demanda (.docx, que YA trae la firma estampada al generarse) se
 * convierte a PDF con LibreOffice headless (`soffice`) y se UNE, en un solo PDF,
 * con los Anexos. Los ANTECEDENTES NO se incluyen (se radican por separado). El
 * resultado se escribe en la MISMA carpeta del cliente en el NAS y se sirve por `/docs`.
 *
 * Ruta del PDF firmado:  {NAS}/{cedula}/DEMANDA FIRMADA - {cedula}.pdf
 *
 * Requisito: LibreOffice instalado (gratis). Se autodetecta en las rutas típicas
 * de Windows; o se fija con la variable de entorno SOFFICE_PATH.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { storage } from '../storage';
import type { IStorage } from '../storage';
import { estamparFirmaDocx } from './firmaStamp';
import { Document } from '../../domain/entities/Document';

const execFileP = promisify(execFile);

function findSoffice(): string | null {
  const env = process.env.SOFFICE_PATH;
  if (env && fs.existsSync(env)) return env;
  const cands = [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null; // último recurso: confiar en que `soffice` esté en el PATH
}

// Bytes de la firma (PNG) para estampar al firmar. Ruta por env (misma imagen que
// usa el motor). null si no está configurada o no existe → se firma sin firma visible.
function cargarFirma(): Buffer | null {
  const p = process.env.FIRMA_PATH || process.env.SAC_FIRMA_PATH;
  if (!p) { console.error('[FIRMA] FIRMA_PATH no configurado en backend/.env → se firma sin estampar la firma'); return null; }
  try {
    return fs.readFileSync(p);
  } catch (e) {
    console.error(`[FIRMA] no se pudo leer la firma (${p}): ${(e as Error).message} → se firma sin estampar`);
    return null;
  }
}

export interface SignedPdfResult {
  relPath: string; // ruta relativa dentro del NAS
  url: string;     // URL pública (/docs/...)
  pages: number;
}

export class SignedPdfService {
  constructor(private readonly store: IStorage = storage) {}

  /** Convierte bytes de un .docx a PDF (Buffer) usando LibreOffice headless. */
  private async docxToPdf(docxBytes: Buffer, baseName: string): Promise<Buffer> {
    const soffice = findSoffice();
    if (!soffice) {
      throw new Error(
        'No se encontró LibreOffice para convertir la demanda a PDF. Instálalo (gratis) o define SOFFICE_PATH en backend/.env.'
      );
    }
    // Carpeta de trabajo temporal + perfil propio (evita el bloqueo si soffice ya corre).
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'firma-'));
    try {
      const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'demanda';
      const docxPath = path.join(work, `${safeBase}.docx`);
      fs.writeFileSync(docxPath, docxBytes);
      const profile = 'file:///' + path.join(work, 'profile').replace(/\\/g, '/');
      await execFileP(
        soffice,
        ['--headless', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', work, docxPath],
        { timeout: 120000 }
      );
      const pdfPath = path.join(work, `${safeBase}.pdf`);
      if (!fs.existsSync(pdfPath)) {
        throw new Error('LibreOffice no generó el PDF de la demanda.');
      }
      return fs.readFileSync(pdfPath);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }
    }
  }

  /** URL pública guardada (anexos/antecedentes) → sus bytes desde el storage, si existe. */
  private async readFromUrl(url?: string | null): Promise<Buffer | null> {
    if (!url) return null;
    const rel = this.store.relPathFromUrl(url);
    if (!rel) return null;
    try {
      if (!(await this.store.exists(rel))) return null;
      return await this.store.read(rel);
    } catch {
      return null;
    }
  }

  private async appendPdf(out: PDFDocument, bytes: Buffer): Promise<void> {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  /**
   * Arma el PDF firmado (demanda + anexos + antecedentes) y lo guarda en el NAS.
   * Devuelve la URL pública y la ruta relativa.
   */
  async build(document: Document): Promise<SignedPdfResult> {
    if (!this.store.enabled) throw new Error('El almacenamiento (DOCS_DIR o Drive) no está configurado: no se puede guardar el PDF firmado.');

    // Ruta del .docx de la demanda en el storage (metadata.demandaRelPath o desde fileUrl).
    const relDocx =
      (document.metadata?.['demandaRelPath'] as string | undefined) ||
      (document.fileUrl && /\.docx?(\?|$)/i.test(document.fileUrl)
        ? this.store.relPathFromUrl(document.fileUrl) ?? undefined
        : undefined);
    if (!relDocx) throw new Error('No se encontró el .docx de la demanda para convertir a PDF.');
    if (!(await this.store.exists(relDocx))) throw new Error('El .docx de la demanda no existe en el almacenamiento.');

    // 1) Estampar la firma en el docx (sobre una COPIA en memoria: el archivo original
    //    queda sin firma), y convertir a PDF. La firma se aplica AL FIRMAR, no antes.
    let docxBytes: Buffer = await this.store.read(relDocx);
    const firma = cargarFirma();
    if (firma) docxBytes = estamparFirmaDocx(docxBytes, firma);
    const baseName = path.basename(String(relDocx)).replace(/\.docx?$/i, '');
    const demandaPdf = await this.docxToPdf(docxBytes, baseName);

    // 2) Unir demanda + anexos en un solo PDF.
    //    Los ANTECEDENTES NO van en la demanda firmada (se radican aparte).
    const out = await PDFDocument.create();
    await this.appendPdf(out, demandaPdf);
    const anexosBytes = await this.readFromUrl(document.anexosUrl);
    if (anexosBytes) await this.appendPdf(out, anexosBytes);

    // 3) Guardar junto a la demanda, en la carpeta del cliente.
    const dir = path.posix.dirname(String(relDocx).replace(/\\/g, '/'));
    const idSeg = document.clientCedula || document.id;
    const relPdf = `${dir}/DEMANDA FIRMADA - ${idSeg}.pdf`;
    const bytes = Buffer.from(await out.save());
    const url = (await this.store.save(relPdf, bytes, 'application/pdf')).url;

    return { relPath: relPdf, url, pages: out.getPageCount() };
  }
}
