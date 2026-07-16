import { Response } from 'express';
import { AuthRequest } from '../middlewares/authMiddleware';
export declare class GenerateController {
    fromExcel(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Genera demandas SINGULARES con el motor real (sac_scripts).
     * Campos (multipart): excelFile (obligatorio), correoPoder (opcional, PDF del
     * banco para el ANEXO 1), fechaAsignacion (opcional).
     * Crea un Document por cliente, con demanda + anexos + antecedentes + asignación
     * y las notas de procedencia.
     */
    singular(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Descarga las obligaciones del SAC por CÉDULA (reemplaza el disparo por ZIP/n8n).
     * Recibe cédulas separadas por "-", "," o espacios; el motor corre el scraping
     * (Puppeteer) y deja SAC_*.pdf + CONTACTOS_*.csv en la carpeta de cada cliente.
     * Síncrono (con timeout alto): el SAC tarda por cédula y corre secuencial.
     */
    descargarSac(req: AuthRequest, res: Response): Promise<void>;
    /**
     * Regenera UNA sola demanda ya existente: vuelve a correr el motor con el Excel
     * de asignación original, filtrado a la cédula de este documento, y SOBREESCRIBE
     * el mismo Document (no crea uno nuevo). Corre en segundo plano; la vista se
     * refresca al llegar la notificación de "generación terminada".
     *
     * Nota: no se reusa el "correo del poder" del lote original (no se persiste), por
     * lo que el ANEXO 1 (poder) puede quedar sin el correo del banco sobrepuesto.
     */
    regenerarUno(req: AuthRequest, res: Response): Promise<void>;
    private regenerarEnSegundoPlano;
    private persistObservaciones;
    private generarEnSegundoPlano;
}
//# sourceMappingURL=GenerateController.d.ts.map