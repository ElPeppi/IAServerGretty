"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignedPdfService = void 0;
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
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const pdf_lib_1 = require("pdf-lib");
const NasStorage_1 = require("./NasStorage");
const firmaStamp_1 = require("./firmaStamp");
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
function findSoffice() {
    const env = process.env.SOFFICE_PATH;
    if (env && fs_1.default.existsSync(env))
        return env;
    const cands = [
        'C:/Program Files/LibreOffice/program/soffice.exe',
        'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        '/opt/libreoffice/program/soffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ];
    for (const c of cands)
        if (fs_1.default.existsSync(c))
            return c;
    return null; // último recurso: confiar en que `soffice` esté en el PATH
}
// Bytes de la firma (PNG) para estampar al firmar. Ruta por env (misma imagen que
// usa el motor). null si no está configurada o no existe → se firma sin firma visible.
function cargarFirma() {
    const p = process.env.FIRMA_PATH || process.env.SAC_FIRMA_PATH;
    if (!p) {
        console.error('[FIRMA] FIRMA_PATH no configurado en backend/.env → se firma sin estampar la firma');
        return null;
    }
    try {
        return fs_1.default.readFileSync(p);
    }
    catch (e) {
        console.error(`[FIRMA] no se pudo leer la firma (${p}): ${e.message} → se firma sin estampar`);
        return null;
    }
}
class SignedPdfService {
    constructor(nas = new NasStorage_1.NasStorage()) {
        this.nas = nas;
    }
    /** Convierte bytes de un .docx a PDF (Buffer) usando LibreOffice headless. */
    async docxToPdf(docxBytes, baseName) {
        const soffice = findSoffice();
        if (!soffice) {
            throw new Error('No se encontró LibreOffice para convertir la demanda a PDF. Instálalo (gratis) o define SOFFICE_PATH en backend/.env.');
        }
        // Carpeta de trabajo temporal + perfil propio (evita el bloqueo si soffice ya corre).
        const work = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'firma-'));
        try {
            const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'demanda';
            const docxPath = path_1.default.join(work, `${safeBase}.docx`);
            fs_1.default.writeFileSync(docxPath, docxBytes);
            const profile = 'file:///' + path_1.default.join(work, 'profile').replace(/\\/g, '/');
            await execFileP(soffice, ['--headless', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', work, docxPath], { timeout: 120000 });
            const pdfPath = path_1.default.join(work, `${safeBase}.pdf`);
            if (!fs_1.default.existsSync(pdfPath)) {
                throw new Error('LibreOffice no generó el PDF de la demanda.');
            }
            return fs_1.default.readFileSync(pdfPath);
        }
        finally {
            try {
                fs_1.default.rmSync(work, { recursive: true, force: true });
            }
            catch { /* limpieza best-effort */ }
        }
    }
    /** URL pública guardada (anexos/antecedentes) → ruta ABSOLUTA en el NAS, si existe. */
    absFromUrl(url) {
        if (!url)
            return null;
        const rel = this.nas.relPathFromUrl(url);
        if (!rel)
            return null;
        try {
            const abs = this.nas.absFromRelPath(rel);
            return fs_1.default.existsSync(abs) ? abs : null;
        }
        catch {
            return null;
        }
    }
    async appendPdf(out, bytes) {
        const src = await pdf_lib_1.PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
    }
    /**
     * Arma el PDF firmado (demanda + anexos + antecedentes) y lo guarda en el NAS.
     * Devuelve la URL pública y la ruta relativa.
     */
    async build(document) {
        if (!this.nas.enabled)
            throw new Error('DOCS_DIR no está configurado: no se puede guardar en el NAS.');
        // Ruta del .docx de la demanda en el NAS (metadata.demandaRelPath o desde fileUrl).
        const relDocx = document.metadata?.['demandaRelPath'] ||
            (document.fileUrl && /\.docx?(\?|$)/i.test(document.fileUrl)
                ? this.nas.relPathFromUrl(document.fileUrl) ?? undefined
                : undefined);
        if (!relDocx)
            throw new Error('No se encontró el .docx de la demanda para convertir a PDF.');
        const docxAbs = this.nas.absFromRelPath(relDocx);
        if (!fs_1.default.existsSync(docxAbs))
            throw new Error('El .docx de la demanda no existe en el NAS.');
        // 1) Estampar la firma en el docx (sobre una COPIA en memoria: el archivo del NAS
        //    queda sin firma), y convertir a PDF. La firma se aplica AL FIRMAR, no antes.
        let docxBytes = fs_1.default.readFileSync(docxAbs);
        const firma = cargarFirma();
        if (firma)
            docxBytes = (0, firmaStamp_1.estamparFirmaDocx)(docxBytes, firma);
        const baseName = path_1.default.basename(String(relDocx)).replace(/\.docx?$/i, '');
        const demandaPdf = await this.docxToPdf(docxBytes, baseName);
        // 2) Unir demanda + anexos en un solo PDF.
        //    Los ANTECEDENTES NO van en la demanda firmada (se radican aparte).
        const out = await pdf_lib_1.PDFDocument.create();
        await this.appendPdf(out, demandaPdf);
        const anexosAbs = this.absFromUrl(document.anexosUrl);
        if (anexosAbs)
            await this.appendPdf(out, fs_1.default.readFileSync(anexosAbs));
        // 3) Guardar junto a la demanda, en la carpeta del cliente.
        const dir = path_1.default.posix.dirname(String(relDocx).replace(/\\/g, '/'));
        const idSeg = document.clientCedula || document.id;
        const relPdf = `${dir}/DEMANDA FIRMADA - ${idSeg}.pdf`;
        const bytes = Buffer.from(await out.save());
        const url = this.nas.saveBuffer(bytes, relPdf);
        return { relPath: relPdf, url, pages: out.getPageCount() };
    }
}
exports.SignedPdfService = SignedPdfService;
//# sourceMappingURL=SignedPdfService.js.map