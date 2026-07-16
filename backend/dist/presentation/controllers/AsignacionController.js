"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsignacionController = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const XLSX = __importStar(require("xlsx"));
const client_1 = require("../../infrastructure/database/prisma/client");
const EngineService_1 = require("../../infrastructure/services/EngineService");
const FileStorage_1 = require("../../infrastructure/services/FileStorage");
const NasStorage_1 = require("../../infrastructure/services/NasStorage");
const NotificationHub_1 = require("../../infrastructure/services/NotificationHub");
const settings_1 = require("../../infrastructure/config/settings");
const engineService = new EngineService_1.EngineService();
const fileStorage = new FileStorage_1.FileStorage();
const nas = new NasStorage_1.NasStorage();
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MESES = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
// "11 DE JUNIO DE 2026", "31 MARZO 2026", "(30 ENERO 2026)", "10 julio 2026" →
// Date. El "de" es opcional (los Excel de la oficina lo omiten). null si no matchea.
function fechaDesdeNombre(nombre) {
    const m = nombre
        .toLowerCase()
        .match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\s+(?:de\s+)?(\d{4})/i);
    if (!m)
        return null;
    const dia = parseInt(m[1], 10);
    const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
    const anio = parseInt(m[3], 10);
    if (!mes || dia < 1 || dia > 31)
        return null;
    return new Date(anio, mes - 1, dia);
}
function fechaDMY(d) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function nombreLote(filename) {
    return filename.replace(/\.(xlsx|xls|csv)$/i, '').trim();
}
// Parsea el Excel a filas (objetos por columna).
function parseFilas(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet)
        return [];
    return XLSX.utils.sheet_to_json(sheet);
}
function contarCedulas(filas) {
    let n = 0;
    for (const f of filas)
        if (String(f['IDENTIFICACION'] ?? '').trim())
            n++;
    return n;
}
class AsignacionController {
    // POST /api/asignaciones  (multipart: excelFile) → cachea la asignación (NO genera demanda).
    async subir(req, res) {
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
            const fecha = (req.body.fechaAsignacion ? new Date(req.body.fechaAsignacion) : null) ||
                fechaDesdeNombre(nombre);
            const safeName = nombre.replace(/[^a-zA-Z0-9._-]/g, '_');
            const excelUrl = nas.enabled
                ? nas.saveBuffer(file.buffer, `_asignaciones/${safeName}-${Date.now()}.xlsx`)
                : fileStorage.saveBuffer(file.buffer, `${safeName}.xlsx`, XLSX_MIME).url;
            const asignacion = await client_1.prisma.asignacion.upsert({
                where: { nombre },
                create: {
                    nombre,
                    fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : null,
                    excelUrl,
                    filas: filas,
                    totalFilas: contarCedulas(filas),
                    lawyerId: req.user.userId,
                },
                update: {
                    fechaAsignacion: fecha && !isNaN(fecha.getTime()) ? fecha : undefined,
                    excelUrl,
                    filas: filas,
                    totalFilas: contarCedulas(filas),
                },
            });
            res.status(201).json({ success: true, asignacion: this.resumen(asignacion) });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al cachear la asignación';
            res.status(500).json({ message });
        }
    }
    // GET /api/asignaciones → lista (resumen + nº de poderes cacheados).
    async listar(req, res) {
        try {
            const items = await client_1.prisma.asignacion.findMany({
                orderBy: { createdAt: 'desc' },
                include: { _count: { select: { poderes: true, documentos: true } } },
            });
            res.json({ asignaciones: items.map((a) => this.resumen(a)) });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al listar asignaciones';
            res.status(500).json({ message });
        }
    }
    // POST /api/asignaciones/actualizar → escanea ASIGNACIONES_DIR y agrega las que falten.
    async actualizar(req, res) {
        try {
            const dir = process.env.ASIGNACIONES_DIR || '';
            if (!dir) {
                res.status(400).json({ message: 'ASIGNACIONES_DIR no está configurado en el backend (.env).' });
                return;
            }
            if (!fs_1.default.existsSync(dir)) {
                res.status(400).json({ message: `La carpeta de asignaciones no existe: ${dir}` });
                return;
            }
            const archivos = fs_1.default.readdirSync(dir).filter((f) => /\.(xlsx|xls)$/i.test(f) && !f.startsWith('~$'));
            const existentes = new Set((await client_1.prisma.asignacion.findMany({ select: { nombre: true } })).map((a) => a.nombre));
            let agregadas = 0;
            const nuevas = [];
            for (const f of archivos) {
                const nombre = nombreLote(f);
                if (existentes.has(nombre))
                    continue;
                try {
                    const buffer = fs_1.default.readFileSync(path_1.default.join(dir, f));
                    const filas = parseFilas(buffer);
                    if (!filas.length)
                        continue;
                    const fecha = fechaDesdeNombre(nombre);
                    const safeName = nombre.replace(/[^a-zA-Z0-9._-]/g, '_');
                    const excelUrl = nas.enabled
                        ? nas.saveBuffer(buffer, `_asignaciones/${safeName}-${Date.now()}.xlsx`)
                        : fileStorage.saveBuffer(buffer, `${safeName}.xlsx`, XLSX_MIME).url;
                    await client_1.prisma.asignacion.create({
                        data: {
                            nombre,
                            fechaAsignacion: fecha ?? null,
                            excelUrl,
                            filas: filas,
                            totalFilas: contarCedulas(filas),
                            lawyerId: req.user.userId,
                        },
                    });
                    agregadas++;
                    nuevas.push(nombre);
                }
                catch (e) {
                    console.error('[asignaciones/actualizar]', f, e instanceof Error ? e.message : e);
                }
            }
            res.json({ success: true, escaneadas: archivos.length, agregadas, nuevas });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al actualizar asignaciones';
            res.status(500).json({ message });
        }
    }
    // POST /api/asignaciones/:id/generar-poderes  { docsEnServidor } → Word combinado + cache Poder.
    async generarPoderes(req, res) {
        try {
            const id = req.params['id'];
            const asignacion = await client_1.prisma.asignacion.findUnique({ where: { id } });
            if (!asignacion) {
                res.status(404).json({ message: 'Asignación no encontrada' });
                return;
            }
            const docsEnServidor = !!req.body.docsEnServidor;
            const filas = asignacion.filas ?? [];
            const result = await engineService.generarPoderes({
                filas,
                docsEnServidor,
                fechaAsignacion: asignacion.fechaAsignacion ? fechaDMY(asignacion.fechaAsignacion) : undefined,
                nombre: asignacion.nombre,
            });
            if (!result.success) {
                res.status(422).json({ message: result.error || 'No se pudieron generar los poderes', excluidos: result.excluidos });
                return;
            }
            // Guardar el Word combinado bajo /docs para poder servirlo/descargarlo.
            let poderUrl;
            if (result.poderBase64) {
                const buf = Buffer.from(result.poderBase64, 'base64');
                poderUrl = nas.enabled
                    ? nas.saveBuffer(buf, `_poderes/${asignacion.id}.docx`)
                    : fileStorage.saveBase64(result.poderBase64, result.poderFilename || `poderes-${asignacion.id}.docx`, DOCX_MIME).url;
            }
            // Reemplazar los poderes cacheados de esta asignación.
            await client_1.prisma.$transaction([
                client_1.prisma.poder.deleteMany({ where: { asignacionId: asignacion.id } }),
                client_1.prisma.poder.createMany({
                    data: result.clientes.map((c) => ({
                        asignacionId: asignacion.id,
                        cedula: c.cedula,
                        nombre: c.nombre || null,
                        ciudadJuzgado: c.ciudadJuzgado || null,
                        tipoJuzgado: c.tipoJuzgado || null,
                        numeroPagare: c.numeroPagare || c.pagare || null,
                        pagareDesdeDocs: !!c.pagareDesdeDocs,
                    })),
                }),
                client_1.prisma.asignacion.update({
                    where: { id: asignacion.id },
                    data: { poderUrl, poderGeneradoAt: new Date(), docsEnServidor },
                }),
            ]);
            NotificationHub_1.notificationHub.broadcast({
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
        }
        catch (error) {
            const axiosCode = error.code;
            if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ENOTFOUND') {
                res.status(503).json({ message: 'El motor no está disponible. Verifica que sac_scripts esté corriendo.' });
                return;
            }
            const resp = error.response;
            const message = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'Error al generar poderes');
            res.status(500).json({ message });
        }
    }
    // POST /api/asignaciones/:id/generar-demandas → genera las demandas de la asignación
    // REUSANDO el poder cacheado. Si no hay poder enlazado, responde 409 (el frontend
    // muestra el popup de "subir o generar"). Corre en segundo plano.
    async generarDemandas(req, res) {
        try {
            const id = req.params['id'];
            const asignacion = await client_1.prisma.asignacion.findUnique({ where: { id } });
            if (!asignacion) {
                res.status(404).json({ message: 'Asignación no encontrada' });
                return;
            }
            if (!asignacion.poderUrl) {
                res.status(409).json({ codigo: 'SIN_PODER', message: 'No hay poder enlazado a esta asignación.' });
                return;
            }
            const filas = asignacion.filas ?? [];
            if (!filas.length) {
                res.status(400).json({ message: 'La asignación no tiene filas.' });
                return;
            }
            res.status(202).json({
                success: true,
                started: true,
                message: 'Generación de demandas iniciada en segundo plano. Aparecerán en Documentos en unos minutos.',
            });
            NotificationHub_1.notificationHub.broadcast({
                type: 'generacion',
                level: 'info',
                title: 'Generación de demandas iniciada',
                message: `Generando las demandas de "${asignacion.nombre}"…`,
                meta: { asignacionId: asignacion.id },
            });
            void this.generarDemandasBg({
                asignacionId: asignacion.id,
                nombre: asignacion.nombre,
                filas,
                fechaAsignacion: asignacion.fechaAsignacion,
                lawyerId: req.user.userId,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al generar demandas';
            res.status(500).json({ message });
        }
    }
    // Corre el motor sobre las filas cacheadas, crea los Document (enlazados a la
    // asignación) y RECONCILIA los poderes cacheados: si la demanda trae un valor
    // distinto (nombre/cédula/ciudad/pagaré), manda la demanda y se corrige el poder.
    async generarDemandasBg(input) {
        const t0 = Date.now();
        try {
            // Reconstruir el Excel desde las filas cacheadas (evita releer del NAS).
            const ws = XLSX.utils.json_to_sheet(input.filas);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Asignacion');
            const excel = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            const fechaDMYStr = input.fechaAsignacion ? fechaDMY(input.fechaAsignacion) : undefined;
            const result = await engineService.generateSingular({
                excel,
                excelFilename: `${input.nombre}.xlsx`,
                fechaAsignacion: fechaDMYStr,
                smmv: (0, settings_1.getSettings)().smmv,
                transito: (0, settings_1.getSettings)().transito,
            });
            const fileRef = (f) => {
                if (!f)
                    return undefined;
                if (nas.enabled && f.relPath)
                    return nas.urlForRelPath(f.relPath);
                return fileStorage.saveBase64(f.base64, f.filename, f.mimeType).url;
            };
            let creados = 0;
            for (const doc of result.documentos ?? []) {
                const info = (result.clientes ?? []).find((c) => c.cedula === doc.cedula);
                await client_1.prisma.document.create({
                    data: {
                        title: `Demanda Ejecutiva Singular — ${doc.nombre || doc.cedula}`,
                        type: 'DEMANDA_SINGULAR',
                        status: 'GENERATED',
                        clientName: doc.nombre || doc.cedula,
                        clientCedula: doc.cedula,
                        fileUrl: fileRef(doc.archivos?.demanda),
                        anexosUrl: fileRef(doc.archivos?.anexos),
                        antecedentesUrl: fileRef(doc.archivos?.antecedentes),
                        asignacionId: input.asignacionId,
                        notes: (doc.notas ?? []),
                        lawyerId: input.lawyerId,
                        metadata: {
                            numeroPagare: info?.numeroPagare,
                            demandaRelPath: doc.archivos?.demanda?.relPath,
                            fechaAsignacion: fechaDMYStr ?? null,
                        },
                    },
                });
                creados++;
                await this.reconciliarPoder(input.asignacionId, doc.cedula, doc.nombre, info);
            }
            const omit = (result.omitidos ?? []).length;
            console.error(`[asignaciones/demandas] OK — ${creados} generada(s), ${omit} omitida(s) en ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            NotificationHub_1.notificationHub.broadcast({
                type: 'generacion',
                level: 'success',
                title: 'Demandas generadas',
                message: `${creados} demanda(s) de "${input.nombre}"${omit ? `, ${omit} omitida(s)` : ''}.`,
                meta: { asignacionId: input.asignacionId, creados, omitidos: omit },
            });
        }
        catch (error) {
            const resp = error.response;
            const msg = resp?.data?.error || resp?.data?.message || (error instanceof Error ? error.message : 'error');
            console.error('[asignaciones/demandas] FALLÓ:', msg);
            NotificationHub_1.notificationHub.broadcast({
                type: 'generacion',
                level: 'error',
                title: 'Falló la generación de demandas',
                message: `${input.nombre}: ${String(msg)}`,
                meta: { asignacionId: input.asignacionId },
            });
        }
    }
    // Reconcilia el poder cacheado de un cliente contra los datos de la demanda.
    // La demanda MANDA: si difiere nombre/ciudad/pagaré, se corrige el poder.
    async reconciliarPoder(asignacionId, cedula, nombreDemanda, info) {
        try {
            const poder = await client_1.prisma.poder.findFirst({ where: { asignacionId, cedula } });
            if (!poder)
                return;
            const cambios = {};
            const nombre = (nombreDemanda || info?.nombre || '').trim();
            if (nombre && nombre !== (poder.nombre || '').trim())
                cambios.nombre = nombre;
            if (info?.ciudad && info.ciudad.trim() !== (poder.ciudadJuzgado || '').trim())
                cambios.ciudadJuzgado = info.ciudad.trim();
            if (info?.tipoJuzgadoFinal && info.tipoJuzgadoFinal.trim() !== (poder.tipoJuzgado || '').trim())
                cambios.tipoJuzgado = info.tipoJuzgadoFinal.trim();
            if (info?.numeroPagare && String(info.numeroPagare).trim() !== (poder.numeroPagare || '').trim())
                cambios.numeroPagare = String(info.numeroPagare).trim();
            if (Object.keys(cambios).length) {
                await client_1.prisma.poder.update({ where: { id: poder.id }, data: cambios });
                console.error(`[asignaciones/demandas] poder ${cedula} reconciliado:`, Object.keys(cambios).join(', '));
            }
        }
        catch (e) {
            console.error(`[asignaciones/demandas] reconciliar poder ${cedula}:`, e instanceof Error ? e.message : e);
        }
    }
    // POST /api/asignaciones/:id/poder  (multipart: poderFile) → enlaza un Word de poderes ya hecho.
    async subirPoder(req, res) {
        try {
            const id = req.params['id'];
            const file = req.file;
            if (!file) {
                res.status(400).json({ message: 'Archivo Word requerido (campo: poderFile)' });
                return;
            }
            const asignacion = await client_1.prisma.asignacion.findUnique({ where: { id } });
            if (!asignacion) {
                res.status(404).json({ message: 'Asignación no encontrada' });
                return;
            }
            const poderUrl = nas.enabled
                ? nas.saveBuffer(file.buffer, `_poderes/${asignacion.id}.docx`)
                : fileStorage.saveBuffer(file.buffer, `poderes-${asignacion.id}.docx`, DOCX_MIME).url;
            await client_1.prisma.asignacion.update({
                where: { id: asignacion.id },
                data: { poderUrl, poderGeneradoAt: new Date() },
            });
            res.json({ success: true, poderUrl });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Error al subir el poder';
            res.status(500).json({ message });
        }
    }
    // Forma resumida para la UI.
    resumen(a) {
        return {
            id: a.id,
            nombre: a.nombre,
            fechaAsignacion: a.fechaAsignacion,
            totalFilas: a.totalFilas,
            tienePoder: !!a.poderUrl,
            poderUrl: a.poderUrl,
            poderGeneradoAt: a.poderGeneradoAt,
            docsEnServidor: a.docsEnServidor,
            poderesCacheados: a._count?.poderes ?? 0,
            demandas: a._count?.documentos ?? 0,
            createdAt: a.createdAt,
        };
    }
}
exports.AsignacionController = AsignacionController;
//# sourceMappingURL=AsignacionController.js.map