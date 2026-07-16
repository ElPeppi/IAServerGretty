export declare class NasStorage {
    /** ¿Está configurado el NAS (DOCS_DIR)? */
    get enabled(): boolean;
    get root(): string;
    /** Ruta relativa (posix) → URL pública servida por /docs. */
    urlForRelPath(rel: string): string;
    /** URL pública (o fileUrl guardada) → ruta relativa dentro del NAS. */
    relPathFromUrl(url: string): string | null;
    /** Resuelve una ruta relativa a una ABSOLUTA dentro del NAS (evita path traversal). */
    absFromRelPath(rel: string): string;
    /** Escribe un archivo nuevo en el NAS y devuelve su URL pública. */
    saveBuffer(buffer: Buffer, rel: string): string;
    /** Sobreescribe un archivo EXISTENTE del NAS (usado por el editor de la demanda). */
    overwrite(rel: string, buffer: Buffer): void;
}
//# sourceMappingURL=NasStorage.d.ts.map