import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class AsignacionController {
    subir(req: AuthRequest, res: Response): Promise<void>;
    listar(req: AuthRequest, res: Response): Promise<void>;
    actualizar(req: AuthRequest, res: Response): Promise<void>;
    generarPoderes(req: AuthRequest, res: Response): Promise<void>;
    generarDemandas(req: AuthRequest, res: Response): Promise<void>;
    private generarDemandasBg;
    private reconciliarPoder;
    subirPoder(req: AuthRequest, res: Response): Promise<void>;
    private resumen;
}
//# sourceMappingURL=AsignacionController.d.ts.map