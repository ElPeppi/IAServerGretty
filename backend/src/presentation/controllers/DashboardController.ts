import { Response } from 'express';
import { GetDashboardStatsUseCase } from '../../application/use-cases/dashboard/GetDashboardStatsUseCase';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { prisma } from '../../infrastructure/database/prisma/client';
import { AuthRequest } from '../middlewares/authMiddleware';

const documentRepository = new PrismaDocumentRepository();
const getDashboardStatsUseCase = new GetDashboardStatsUseCase(documentRepository);

export class DashboardController {
  async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      const isAdmin = req.user?.role === 'ADMIN';
      const stats = await getDashboardStatsUseCase.execute(
        isAdmin ? undefined : req.user?.userId
      );
      res.json(stats);
    } catch {
      res.status(500).json({ message: 'Error al obtener estadísticas' });
    }
  }

  // Observaciones: demandas NO generadas (y por qué). Admin ve todas; abogado, las suyas.
  async getObservaciones(req: AuthRequest, res: Response): Promise<void> {
    try {
      const isAdmin = req.user?.role === 'ADMIN';
      const items = await prisma.observacion.findMany({
        where: isAdmin ? {} : { lawyerId: req.user?.userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, cedula: true, nombre: true, motivo: true, lote: true, createdAt: true },
      });
      res.json(items);
    } catch (e) {
      console.error('[OBSERVACIONES]', e);
      res.status(500).json({ message: 'Error al obtener observaciones' });
    }
  }
}
