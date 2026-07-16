import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class DocumentController {
    getAll(req: AuthRequest, res: Response): Promise<void>;
    getById(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Sobreescribe el .docx de la demanda en el NAS con la versión editada desde la
     * web (editor SuperDoc). No copia a S3 ni al disco del servidor: edita el archivo
     * original. Permitido al dueño de la demanda o a un ADMIN (no a demandas firmadas).
     */
    saveFile(req: AuthRequest, res: Response): Promise<void>;
    sign(req: AuthRequest, res: Response): Promise<void>;
}
//# sourceMappingURL=DocumentController.d.ts.map