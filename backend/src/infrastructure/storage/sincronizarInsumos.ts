/**
 * sincronizarInsumos — repone en el servidor, desde Drive, los archivos que el
 * motor necesita para generar: plantillas (.docx/.xlsx), la firma y los
 * certificados compartidos (CCO J Ramos, SIRNA, Super Financiera, CCO Finandina).
 *
 * POR QUÉ: esos archivos NO se leen de Drive al generar — el motor los abre del
 * disco. Antes había que copiarlos a mano por SSH cada vez que la oficina subía
 * los certificados del mes, y si no se hacía, las demandas salían con los del mes
 * anterior sin error ni aviso. Ahora Drive es la única fuente de verdad.
 *
 * CÓMO: el motor declara en `GET /insumos` qué carpetas necesita y qué tiene en
 * ellas (con MD5). Aquí se compara contra el MD5 que Drive publica —sin descargar—
 * y solo se baja y se repone lo que cambió. En un mes normal no se transfiere nada.
 *
 * Se conserva lo descargado a propósito, en vez de borrarlo al terminar el lote:
 *   - los lotes se solapan (generación en segundo plano + concurrencia del SAC), y
 *     borrar mientras otro lote lee daría fallos aleatorios;
 *   - si Drive falla, se sigue generando con la última copia buena;
 *   - evita rebajar los mismos MB en cada lote.
 *
 * Nunca lanza: un fallo de Drive degrada a "genera con lo que hay en disco", que
 * es exactamente el comportamiento anterior.
 */
import { storage } from './index';
import { BANCO_DEFAULT, CARPETA_PROCESO, RAIZ_DEMANDAS, unir } from './rutas';
import { EngineService } from '../services/EngineService';
import { InsumoDestino } from '../../application/services/IEngineService';

const engine = new EngineService();

/**
 * Destino declarado por el motor → carpetas de Drive de donde se surte, EN ORDEN
 * de preferencia. Las rutas replican el árbol de la oficina (ver rutas.ts).
 *
 * Las plantillas salen de DOS sitios: cada proceso tiene su propio árbol y la
 * oficina guarda ahí sus plantillas. El poder del trámite de pago directo vive
 * en GARANTIA MOBILIARIAS/PLANTILLAS, no junto a las del ejecutivo singular.
 */
function origenesEnDrive(destino: string): string[] {
  const banco = BANCO_DEFAULT;
  switch (destino) {
    case 'plantillas':
      return [
        unir(RAIZ_DEMANDAS, banco, CARPETA_PROCESO.singular, 'PLANTILLAS'),
        unir(RAIZ_DEMANDAS, banco, CARPETA_PROCESO.pago_directo, 'PLANTILLAS'),
      ];
    case 'anexos_demandas':
      return [RAIZ_DEMANDAS];
    case 'anexos_finandina':
      return [unir(RAIZ_DEMANDAS, banco)];
    // El directorio SIJIN es común a todos los bancos: cuelga de DEMANDAS/, no
    // de la carpeta de ninguno.
    case 'directorios':
      return [RAIZ_DEMANDAS];
    default:
      return []; // destino nuevo en el motor que este backend aún no sabe surtir
  }
}

export interface ResultadoSync {
  repuestos: string[];
  errores: string[];
  omitidos: number;  // ya estaban al día
  // Candidatos VISTOS en Drive. Sirve para distinguir "todo al día" de "no
  // encontré nada": si la carpeta de Drive no existe o cambió de sitio, no hay
  // error —simplemente no hay nada que traer— y sin este dato el resultado
  // parecería un éxito.
  revisados: number;
}

// Varios lotes pueden arrancar a la vez (generación en segundo plano). Sin esto,
// tres lotes simultáneos harían tres veces el mismo listado de Drive y podrían
// pisarse escribiendo el mismo archivo.
let enCurso: Promise<ResultadoSync> | null = null;
let ultimaOk = 0;
const FRESCO_MS = 60 * 1000;

/**
 * @param forzar ignora la ventana de "recién sincronizado" (para el botón manual).
 */
export async function sincronizarInsumos(forzar = false): Promise<ResultadoSync> {
  if (enCurso) return enCurso;
  if (!forzar && Date.now() - ultimaOk < FRESCO_MS) {
    return { repuestos: [], errores: [], omitidos: 0, revisados: 0 };
  }
  enCurso = ejecutar();
  try {
    return await enCurso;
  } finally {
    enCurso = null;
  }
}

async function ejecutar(): Promise<ResultadoSync> {
  const res: ResultadoSync = { repuestos: [], errores: [], omitidos: 0, revisados: 0 };
  try {
    await recolectar(res);
  } finally {
    // SIEMPRE se deja rastro, también al fallar: quien llama (la generación en
    // segundo plano) descarta el resultado, así que este log es el único sitio
    // donde se puede ver que las demandas salieron con insumos viejos.
    const detalle = res.errores.length ? ` — ${res.errores.join(' | ')}` : '';
    const linea = `[INSUMOS] ${res.repuestos.length} repuesto(s), ${res.omitidos} al día,`
      + ` ${res.revisados} visto(s) en Drive${detalle}`;
    if (res.errores.length || res.revisados === 0) console.warn(linea); else console.log(linea);
  }
  if (res.errores.length === 0) ultimaOk = Date.now();
  return res;
}

async function recolectar(res: ResultadoSync): Promise<void> {
  if (!storage.enabled) {
    res.errores.push('El almacenamiento no está configurado; no se sincronizó nada.');
    return;
  }

  let destinos: InsumoDestino[];
  try {
    destinos = await engine.listarInsumos();
  } catch (e) {
    res.errores.push(`El motor no respondió qué insumos necesita: ${mensaje(e)}`);
    return;
  }

  for (const d of destinos) {
    // Hash de lo que YA tiene el servidor, por nombre de archivo.
    const local = new Map(d.archivos.map((a) => [a.archivo, a.hash]));
    // Un mismo nombre puede existir en varias carpetas de origen; gana la primera.
    const yaVisto = new Set<string>();

    for (const origen of origenesEnDrive(d.destino)) {
      try {
        await sincronizarDestino(d, origen, local, yaVisto, res);
      } catch (e) {
        res.errores.push(`${d.destino} ← ${origen}: ${mensaje(e)}`);
      }
    }
  }
}

async function sincronizarDestino(
  d: InsumoDestino,
  origen: string,
  local: Map<string, string>,
  yaVisto: Set<string>,
  res: ResultadoSync,
): Promise<void> {
  const remotos = await storage.listDetallado(origen);

  for (const r of remotos) {
    // `requeridos` no nulo = carpeta de nombres fijos (plantillas): todo lo demás
    // que la oficina guarde ahí se ignora. Nulo = cualquier PDF sirve (anexos).
    if (d.requeridos ? !d.requeridos.includes(r.nombre) : !/\.pdf$/i.test(r.nombre)) continue;
    // Sin md5 es un formato nativo de Google (Doc/Sheet), no un archivo real: no
    // se puede comparar ni sirve como insumo.
    if (!r.md5) continue;
    if (yaVisto.has(r.nombre)) continue;
    yaVisto.add(r.nombre);

    res.revisados++;
    if (local.get(r.nombre) === r.md5) { res.omitidos++; continue; }

    const buf = await storage.read(unir(origen, r.nombre));
    await engine.subirInsumo({ destino: d.destino, nombre: r.nombre, archivo: buf });
    res.repuestos.push(`${d.destino}/${r.nombre}`);
  }
}

function mensaje(e: unknown): string {
  const data = (e as { response?: { data?: { error?: string; message?: string } } }).response?.data;
  return data?.error ?? data?.message ?? (e instanceof Error ? e.message : String(e));
}
