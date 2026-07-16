export interface TransitoEntry {
    ciudad: string;
    entidad: string;
    correo: string;
}
export interface AppSettings {
    smmv: number;
    transito: TransitoEntry[];
}
export declare function getSettings(): AppSettings;
export declare function updateSettings(partial: Partial<AppSettings>): AppSettings;
//# sourceMappingURL=settings.d.ts.map