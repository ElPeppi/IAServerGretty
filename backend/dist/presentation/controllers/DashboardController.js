"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardController = void 0;
const GetDashboardStatsUseCase_1 = require("../../application/use-cases/dashboard/GetDashboardStatsUseCase");
const DocumentRepository_1 = require("../../infrastructure/database/prisma/DocumentRepository");
const client_1 = require("../../infrastructure/database/prisma/client");
const documentRepository = new DocumentRepository_1.PrismaDocumentRepository();
const getDashboardStatsUseCase = new GetDashboardStatsUseCase_1.GetDashboardStatsUseCase(documentRepository);
class DashboardController {
    async getStats(req, res) {
        try {
            const isAdmin = req.user?.role === 'ADMIN';
            const stats = await getDashboardStatsUseCase.execute(isAdmin ? undefined : req.user?.userId);
            res.json(stats);
        }
        catch {
            res.status(500).json({ message: 'Error al obtener estadísticas' });
        }
    }
    // Observaciones: demandas NO generadas (y por qué). Admin ve todas; abogado, las suyas.
    async getObservaciones(req, res) {
        try {
            const isAdmin = req.user?.role === 'ADMIN';
            const items = await client_1.prisma.observacion.findMany({
                where: isAdmin ? {} : { lawyerId: req.user?.userId },
                orderBy: { createdAt: 'desc' },
                take: 100,
                select: { id: true, cedula: true, nombre: true, motivo: true, lote: true, createdAt: true },
            });
            res.json(items);
        }
        catch (e) {
            console.error('[OBSERVACIONES]', e);
            res.status(500).json({ message: 'Error al obtener observaciones' });
        }
    }
}
exports.DashboardController = DashboardController;
//# sourceMappingURL=DashboardController.js.map