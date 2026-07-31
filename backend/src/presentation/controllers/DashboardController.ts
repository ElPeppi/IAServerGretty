import { Response } from 'express';
import { GetDashboardStatsUseCase } from '../../application/use-cases/dashboard/GetDashboardStatsUseCase';
import { PrismaDocumentRepository } from '../../infrastructure/database/prisma/DocumentRepository';
import { prisma } from '../../infrastructure/database/prisma/client';
import { AuthRequest } from '../middlewares/authMiddleware';

const documentRepository = new PrismaDocumentRepository();
const getDashboardStatsUseCase = new GetDashboardStatsUseCase(documentRepository);

export class DashboardController {
  async getStats(_req: AuthRequest, res: Response): Promise<void> {
    try {
      // Trabajo en común: todos los usuarios ven las estadísticas de TODAS las
      // demandas, igual que el listado de Documentos.
      const stats = await getDashboardStatsUseCase.execute(undefined);
      res.json(stats);
    } catch {
      res.status(500).json({ message: 'Error al obtener estadísticas' });
    }
  }

  // Observaciones: demandas NO generadas (y por qué). Todos ven todas.
  async getObservaciones(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const items = await prisma.observacion.findMany({
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
