/**
 * storage — factory que elige la implementación por env STORAGE_DRIVER.
 *
 * Uso en el backend (reemplaza a `new NasStorage()`):
 *   import { storage } from '../../infrastructure/storage';
 *   await storage.save(relPath, buffer, mime);
 *
 * STORAGE_DRIVER=nas    → FsStorage (disco/NAS, comportamiento actual)  [default]
 * STORAGE_DRIVER=drive  → DriveStorage (Google Drive API)
 *
 * Envs relacionados:
 *   FsStorage:    DOCS_DIR
 *   DriveStorage: DRIVE_SA_KEY, DRIVE_IMPERSONATE_USER, DRIVE_ROOT_FOLDER_ID
 */
import { IStorage } from './IStorage';
import { FsStorage } from './FsStorage';
import { DriveStorage } from './DriveStorage';

function crear(): IStorage {
  if ((process.env.STORAGE_DRIVER || 'nas').toLowerCase() === 'drive') {
    return new DriveStorage();
  }
  return new FsStorage();
}

export const storage: IStorage = crear();
export type { IStorage, StorageObject } from './IStorage';
export { FsStorage } from './FsStorage';
export { DriveStorage } from './DriveStorage';
