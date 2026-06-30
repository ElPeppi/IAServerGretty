import fs from 'fs';
import path from 'path';

// Configuración editable de la app (SMMV para los umbrales de cuantía y el
// directorio de tránsito). Se guarda en data/settings.json.
const FILE = path.join(process.cwd(), 'data', 'settings.json');

// Directorio de tránsito: por ciudad, la entidad de tránsito y su correo, para
// llenar «STRIA_MCPAL_TTOyTTE» / «DIRECCION_ELECTRONICA_DEL_TRANSITO» cuando el
// Excel no los trae. Se cargan/editan desde el panel de Configuración.
export interface TransitoEntry {
  ciudad: string;
  entidad: string;
  correo: string;
}

export interface AppSettings {
  smmv: number; // salario mínimo mensual vigente
  transito: TransitoEntry[];
}

const DEFAULTS: AppSettings = { smmv: 1_750_905, transito: [] };

export function getSettings(): AppSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...partial };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
