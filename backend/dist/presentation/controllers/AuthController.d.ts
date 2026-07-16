import { Request, Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class AuthController {
    login(req: Request, res: Response): Promise<void>;
    register(req: Request, res: Response): Promise<void>;
    me(req: AuthRequest, res: Response): Promise<void>;
    updateProfile(req: AuthRequest, res: Response): Promise<void>;
    changePassword(req: AuthRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=AuthController.d.ts.map