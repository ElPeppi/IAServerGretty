import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class DashboardController {
    getStats(req: AuthRequest, res: Response): Promise<void>;
    getObservaciones(req: AuthRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=DashboardController.d.ts.map