/**
 * IStorage — contrato único de almacenamiento de documentos.
 *
 * Implementaciones: FsStorage (NAS/disco, comportamiento actual) y DriveStorage
 * (Google Drive API). El resto del código usa esta interfaz vía la factory
 * `storage` (ver index.ts) y nunca sabe cuál está detrás.
 *
 * Modelo: cada archivo se identifica por `relPath` = "{cedula}/{nombre}", en formato
 * posix (separador "/"). La implementación lo traduce a ruta de disco o a fileId.
 */

export interface StorageObject {
  /** Ruta relativa dentro del almacenamiento (posix). */
  relPath: string;
  /** URL pública servida por el backend (/docs/...). */
  url: string;
}

export interface IStorage {
  /** ¿Está configurado y listo para usarse? */
  readonly enabled: boolean;

  /** Crea o REEMPLAZA el archivo en `relPath`. Devuelve su URL pública. */
  save(relPath: string, data: Buffer, mime?: string): Promise<StorageObject>;

  /** Sobrescribe un archivo EXISTENTE (editor SuperDoc). Falla si no existe. */
  overwrite(relPath: string, data: Buffer): Promise<void>;

  /** Lee el archivo completo en memoria (p. ej. el .docx antes de firmar). */
  read(relPath: string): Promise<Buffer>;

  /** Stream de lectura para servir /docs sin cargar todo en memoria. */
  stream(relPath: string): Promise<NodeJS.ReadableStream>;

  /** ¿Existe el archivo? */
  exists(relPath: string): Promise<boolean>;

  /**
   * Lista los NOMBRES de las entradas directas dentro de `relDir` (un directorio
   * relativo, p. ej. "{cedula}" o "{cedula}_07_2026"). Devuelve [] si no existe.
   * Reemplaza los `fs.readdirSync(abs)` que hoy hacen los controllers (p. ej. el
   * gate SAC que busca `SAC_*.pdf`), que en Drive no se pueden hacer por ruta.
   */
  list(relDir: string): Promise<string[]>;

  /** URL pública (/docs/{relPath}) para guardar en la BD y mostrar en la web. */
  urlFor(relPath: string): string;

  /** URL pública o guardada → relPath dentro del almacenamiento (o null). */
  relPathFromUrl(url: string): string | null;

  /** (Opcional) Borra el archivo. */
  delete?(relPath: string): Promise<void>;
}
