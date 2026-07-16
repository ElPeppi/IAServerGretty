import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class UsersController {
    list(_req: AuthRequest, res: Response): Promise<void>;
    create(req: AuthRequest, res: Response): Promise<void>;
    resetPassword(req: AuthRequest, res: Response): Promise<void>;
    viewPassword(req: AuthRequest, res: Response): Promise<void>;
    remove(req: AuthRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=UsersController.d.ts.map