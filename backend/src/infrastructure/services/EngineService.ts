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
  DescargarSacInput,
  DescargarSacOutput,
  GenerarPoderesInput,
  GenerarPoderesOutput,
  MapearColumnasInput,
  MapearColumnasOutput,
  PlantillaInfo,
  PlantillaResult,
  InsumoDestino,
  SubirInsumoInput,
  GenerateGarantiasInput,
  GenerateGarantiasOutput,
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
    if (input.soloCedulas?.length) form.append('soloCedulas', JSON.stringify(input.soloCedulas));
    if (input.correcciones && Object.keys(input.correcciones).length)
      form.append('correcciones', JSON.stringify(input.correcciones));

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

  async generateGarantias(input: GenerateGarantiasInput): Promise<GenerateGarantiasOutput> {
    const form = new FormData();
    form.append('excelFile', input.excel, {
      filename: input.excelFilename || 'entrada.xlsx',
      contentType: XLSX_MIME,
    });
    if (input.soloCedulas?.length) form.append('soloCedulas', JSON.stringify(input.soloCedulas));
    if (input.correoPoder) {
      form.append('correoPoder', input.correoPoder, {
        filename: 'CORREO_PODER.pdf',
        contentType: 'application/pdf',
      });
    }

    const { data } = await axios.post<GenerateGarantiasOutput>(
      `${this.baseUrl}/generar-garantias`,
      form,
      {
        headers: form.getHeaders(),
        // Mismo timeout largo que el singular: aquí lo lento es el OCR del
        // contrato de prenda de cada cliente, no el scraping.
        timeout: Number(process.env.ENGINE_TIMEOUT_MS) || 3600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return data;
  }

  async descargarSac(input: DescargarSacInput): Promise<DescargarSacOutput> {
    const { data } = await axios.post<DescargarSacOutput>(
      `${this.baseUrl}/descargar-sac`,
      { cedulas: input.cedulas },
      {
        // El motor responde 202 apenas encola el lote (el scraping sigue en
        // segundo plano y avisa por SSE), así que basta un timeout corto.
        timeout: 30000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return data;
  }

  async generarPoderes(input: GenerarPoderesInput): Promise<GenerarPoderesOutput> {
    const { data } = await axios.post<GenerarPoderesOutput>(
      `${this.baseUrl}/generar-poderes`,
      {
        excelBase64: input.excel.toString('base64'),
        tipo: input.tipo || 'singular',
        docsEnServidor: !!input.docsEnServidor,
        fechaAsignacion: input.fechaAsignacion,
        nombre: input.nombre,
        smmv: input.smmv,
        soloCedulas: input.soloCedulas?.length ? input.soloCedulas : undefined,
        correcciones: input.correcciones && Object.keys(input.correcciones).length
          ? input.correcciones : undefined,
      },
      {
        timeout: Number(process.env.ENGINE_TIMEOUT_MS) || 3600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return data;
  }

  async mapearColumnas(input: MapearColumnasInput): Promise<MapearColumnasOutput> {
    const { data } = await axios.post<MapearColumnasOutput>(
      `${this.baseUrl}/mapear-columnas`,
      { headers: input.headers, filas: input.filas },
      {
        // La heurística es instantánea; el peor caso es el primer Excel de un
        // formato nuevo, que consulta a Ollama (carga del modelo a RAM). Después
        // el motor lo cachea por firma de encabezados.
        timeout: Number(process.env.ENGINE_MAPEO_TIMEOUT_MS) || 300000,
      }
    );
    return data;
  }

  // ─── Plantillas ──────────────────────────────────────────────────────────────
  // Son operaciones de disco local del motor: responden al instante, timeout corto.

  async listarPlantillas(): Promise<PlantillaInfo[]> {
    const { data } = await axios.get<{ success: boolean; plantillas: PlantillaInfo[] }>(
      `${this.baseUrl}/plantillas`,
      { timeout: 15000 },
    );
    return data.plantillas ?? [];
  }

  async restaurarPlantilla(clave: string, archivo: string): Promise<PlantillaResult> {
    const { data } = await axios.post<PlantillaResult>(
      `${this.baseUrl}/plantillas/${encodeURIComponent(clave)}/restaurar`,
      { archivo },
      { timeout: 30000 },
    );
    return data;
  }

  async listarInsumos(): Promise<InsumoDestino[]> {
    const { data } = await axios.get<{ success: boolean; destinos: InsumoDestino[] }>(
      `${this.baseUrl}/insumos`,
      { timeout: 30000 },
    );
    return data.destinos ?? [];
  }

  async subirInsumo(input: SubirInsumoInput): Promise<void> {
    const form = new FormData();
    // El nombre va también como campo: el filename de multipart se puede mutilar
    // con acentos/espacios según el cliente, y aquí el nombre EXACTO importa
    // (el motor elige el certificado por patrón sobre el nombre del archivo).
    form.append('nombre', input.nombre);
    form.append('archivo', input.archivo, { filename: input.nombre });
    await axios.post(`${this.baseUrl}/insumos/${encodeURIComponent(input.destino)}`, form, {
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
    });
  }
}
