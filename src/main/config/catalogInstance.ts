import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ContainerCatalog, createContainerCatalog } from './containerCatalog';
import { IContainerCatalogEntry } from './containerCatalogSchema';
import { readDefaultStorageMount } from './storageMount';

// The app's single container catalog. Everything that launches or lists a
// container asks this module, never the bundled yml files directly.

/** The domain whose container is the default (storage location, CLI). */
export const DEFAULT_CONTAINER_ID = 'neurodesk';

let catalog: ContainerCatalog | null = null;

/**
 * Directory of bundled <id>.yml files. The first location is the built app,
 * the second the source tree (unit tests).
 */
export function bundledContainerDir(): string {
  const built = path.join(__dirname, '../../container_installer');
  return fs.existsSync(built)
    ? built
    : path.join(__dirname, '../../../container_installer');
}

export function getContainerCatalog(): ContainerCatalog {
  if (!catalog) {
    catalog = createContainerCatalog({
      appVersion: app.getVersion(),
      bundledDir: bundledContainerDir(),
      cacheDir: app.getPath('userData')
    });
  }
  return catalog;
}

/** Replace the catalog; for tests. Pass null to rebuild on next use. */
export function setContainerCatalog(value: ContainerCatalog | null): void {
  catalog = value;
}

/** The entry a session launches; throws for an ID the catalog lacks. */
export function requireContainerEntry(id: string): IContainerCatalogEntry {
  const entry = getContainerCatalog().getEntry(id);
  if (!entry) {
    throw new Error(`Unknown container configuration: ${id}`);
  }
  return entry;
}

/**
 * Directory name of the default storage folder, from the default container's
 * catalog entry, or the bundled file if the catalog has no such entry.
 */
export function defaultStorageMount(): string {
  const entry = getContainerCatalog().getEntry(DEFAULT_CONTAINER_ID);
  return entry ? entry.defaultStorageMount : readDefaultStorageMount();
}
