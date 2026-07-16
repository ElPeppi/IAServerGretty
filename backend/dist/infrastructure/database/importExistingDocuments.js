"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Importa a la base de datos las demandas YA generadas que están en la NAS,
 * para que aparezcan en la página. Recorre las carpetas por cédula de `DOCS_DIR`
 * y crea un Document por cada una que tenga su DEMANDA .docx.
 *
 *   DOCS_DIR="/mnt/compartida/.../GARANTIAS" npm run db:import-docs
 *
 * Requiere que el backend sirva `DOCS_DIR` en /docs (ver app.ts) para poder verlas.
 * No duplica: salta las cédulas que ya tienen una demanda singular importada.
 */
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const client_1 = require("./prisma/client");
const DOCS_DIR = process.env.DOCS_DIR;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
function urlFor(...segments) {
    return `${BASE_URL}/docs/${segments.map(encodeURIComponent).join('/')}`;
}
// Extrae el nombre del demandado del nombre del archivo de la demanda.
// Cubre los formatos usados históricamente:
//   "... CONTRA {nombre} CC {cedula}.docx"     (viejo)
//   "... CONTRA {nombre} {cedula}.docx"        (viejo, sin CC)
//   "... SINGULAR {nombre} - {cedula}.docx"    (nuevo, del motor)
function nombreDeArchivo(file, cedula) {
    const base = file.replace(/\.(docx|pdf)$/i, '').replace(/^BORRADOR\s+/i, '');
    const m = base.match(/CONTRA\s+(.+?)\s+(?:C\.?\s*C\.?\s*)?\d{5,}(?:\s+.*)?$/i) || // CONTRA {nombre} [C.C.] {cedula} [Y OTROS…]
        base.match(/CONTRA\s+\d{5,}\s+(.+?)\s*$/i) || // CONTRA {cedula} {nombre}
        base.match(/SINGULAR\s+(.+?)\s*-\s*\d{5,}\s*$/i); // SINGULAR {nombre} - {cedula}
    return m?.[1]?.trim() || cedula;
}
async function main() {
    if (!DOCS_DIR || !fs_1.default.existsSync(DOCS_DIR)) {
        console.error(`❌ DOCS_DIR no definido o inexistente: ${DOCS_DIR}`);
        process.exit(1);
    }
    const lawyer = (await client_1.prisma.user.findFirst({ where: { role: 'LAWYER' } })) ??
        (await client_1.prisma.user.findFirst());
    if (!lawyer) {
        console.error('❌ No hay usuarios. Corre primero `npm run prisma:seed`.');
        process.exit(1);
    }
    // Cédulas ya importadas (1 sola consulta, en memoria) para no duplicar.
    const existentes = new Set((await client_1.prisma.document.findMany({
        where: { type: 'DEMANDA_SINGULAR', clientCedula: { not: null } },
        select: { clientCedula: true },
    })).map((d) => d.clientCedula));
    const folders = fs_1.default
        .readdirSync(DOCS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{5,}/.test(d.name)); // carpetas por cédula
    let creados = 0;
    let saltados = 0;
    for (const dir of folders) {
        const folder = dir.name;
        const cedula = (folder.match(/^(\d{5,})/) || [])[1] || folder;
        const files = fs_1.default.readdirSync(path_1.default.join(DOCS_DIR, folder));
        // Buscar el archivo de la demanda. Prioridad:
        //   1. .docx (no BORRADOR) que mencione DEMANDA/DEMANDANTE + CONTRA/SINGULAR/EJECUT
        //   2. .pdf de la demanda (no RADICACION)
        //   3. lo mismo aceptando BORRADOR (último recurso)
        const noTmp = (f) => !f.startsWith('~$');
        const esDocx = (f) => /\.docx$/i.test(f) && noTmp(f) && /DEMANDA/i.test(f) && /(CONTRA|SINGULAR|EJECUT)/i.test(f);
        const esPdf = (f) => /\.pdf$/i.test(f) && /DEMANDA/i.test(f) && /(CONTRA|SINGULAR|EJECUT)/i.test(f) && !/RADICAC/i.test(f);
        const demanda = files.find((f) => esDocx(f) && !/BORRADOR/i.test(f)) ||
            files.find((f) => esPdf(f) && !/BORRADOR/i.test(f)) ||
            files.find((f) => esDocx(f)) ||
            files.find((f) => esPdf(f));
        if (!demanda) {
            saltados++;
            continue;
        }
        if (existentes.has(cedula)) {
            saltados++;
            continue;
        }
        existentes.add(cedula);
        const anexos = files.find((f) => /^ANEXOS\.pdf$/i.test(f));
        const antecedentes = files.find((f) => /^ANTECEDENTES\.pdf$/i.test(f));
        const nombre = nombreDeArchivo(demanda, cedula);
        await client_1.prisma.document.create({
            data: {
                title: `Demanda Ejecutiva Singular — ${nombre}`,
                type: 'DEMANDA_SINGULAR',
                status: 'GENERATED',
                clientName: nombre,
                clientCedula: cedula,
                fileUrl: urlFor(folder, demanda),
                anexosUrl: anexos ? urlFor(folder, anexos) : null,
                antecedentesUrl: antecedentes ? urlFor(folder, antecedentes) : null,
                lawyerId: lawyer.id,
            },
        });
        creados++;
        console.log(`  + ${cedula} — ${nombre}`);
    }
    console.log(`✅ Importadas ${creados} demanda(s); ${saltados} carpeta(s) saltada(s).`);
}
main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => client_1.prisma.$disconnect());
//# sourceMappingURL=importExistingDocuments.js.map