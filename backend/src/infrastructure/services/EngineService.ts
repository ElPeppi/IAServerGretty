/**
 * EngineService — cliente HTTP del MOTOR de demandas (sac_scripts).
 * Reemplaza la llamada a n8n: el backend manda el Excel (+ correo del poder)
 * al endpoint `/generar-singular` del motor y recibe los documentos por cliente.
 */
import axios from 'axios';
import FormData from 'form-data';
import {
  IEngineService,
  GenerateSingularInput,
  GenerateSingularOutput,
} from '../../application/services/IEngineService';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class EngineService implements IEngineService {
  private readonly baseUrl: string;

  constructor() {
    // El motor sac_scripts corre por defecto en el puerto 3456.
    this.baseUrl = process.env.ENGINE_BASE_URL || 'http://localhost:3456';
  }

  async generateSingular(input: GenerateSingularInput): Promise<GenerateSingularOutput> {
    const form = new FormData();
    form.append('excelFile', input.excel, {
      filename: input.excelFilename || 'entrada.xlsx',
      contentType: XLSX_MIME,
    });
    if (input.correoPoder) {
      form.append('correoPoder', input.correoPoder, {
        filename: input.correoPoderFilename || 'correo.pdf',
        contentType: 'application/pdf',
      });
    }
    if (input.fechaAsignacion) form.append('fechaAsignacion', input.fechaAsignacion);
    if (input.smmv)            form.append('smmv', String(input.smmv));
    if (input.transito?.length) form.append('transito', JSON.stringify(input.transito));

    const { data } = await axios.post<GenerateSingularOutput>(
      `${this.baseUrl}/generar-singular`,
      form,
      {
        headers: form.getHeaders(),
        // Corre en segundo plano (sin navegador esperando): lotes grandes tardan
        // varios minutos por el scraping. Timeout alto y configurable por env.
        timeout: Number(process.env.ENGINE_TIMEOUT_MS) || 3600000, // 60 min por defecto
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return data;
  }
}
