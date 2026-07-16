import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class ConfigController {
    get(_req: AuthRequest, res: Response): Promise<void>;
    update(req: AuthRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=ConfigController.d.ts.map