/**
 * storage — factory que elige la implementación por env STORAGE_DRIVER.
 *
 * ESQUELETO (sin cablear). Destino:
 *   backend/src/infrastructure/storage/index.ts
 *
 * Uso en el resto del backend (reemplaza a `new NasStorage()`):
 *   import { storage } from '../storage';
 *   await storage.save(relPath, buffer, mime);
 *
 * STORAGE_DRIVER=nas   → FsStorage (disco/NAS, comportamiento actual)  [default]
 * STORAGE_DRIVER=drive → DriveStorage (Google Drive API)
 */
import { IStorage } from './IStorage';
import { FsStorage } from './FsStorage';
import { DriveStorage } from './DriveStorage';

function crear(): IStorage {
  if (process.env.STORAGE_DRIVER === 'drive') return new DriveStorage();
  return new FsStorage();
}

export const storage: IStorage = crear();
export type { IStorage, StorageObject } from './IStorage';
