import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import log from 'electron-log';
import { fetchText } from '../net/fetchText';
import {
  CATALOG_SCHEMA_VERSION,
  IContainerCatalogEntry,
  isEntryCompatible,
  parseCatalogDocument,
  validateCatalogEntry
} from './containerCatalogSchema';

// Container catalog: which containers the app can launch, and how. Each
// apps.json domain has one image; its settings are the `container` block of
// that domain in domains.json, keyed by domain ID.
//
// Sources, best first. Every entry from every source passes
// validateCatalogEntry and the minAppVersion check before it is used.
//
//   constructor (sync, never touches the network)
//     disk cache, any age ──valid──► snapshot      source: 'cache'
//     └─ missing/corrupt ──────────► bundled yml   source: 'bundled'
//
//   refresh() (async, never throws)
//     cache younger than ttl ──────► keep snapshot
//     fetch remote domains.json
//       ├─ bad envelope / network error ──► keep snapshot
//       └─ ok, per entry:
//            remote entry valid + compatible ──► use it
//            else that ID in current snapshot  ──► use it (last known good)
//            else that ID's bundled entry      ──► use it
//            else                              ──► drop it, log why
//          drop entries whose containerName another ID already uses
//          result non-empty ──► snapshot = result, write disk cache
//          result empty     ──► keep snapshot
//
// The remote document decides which IDs exist: an ID it no longer lists is
// removed even if the cache or bundle still has it.

export type CatalogSource = 'bundled' | 'cache' | 'remote';

export interface IContainerCatalogOptions {
  /** Remote domains.json. Empty disables network refresh. */
  url: string;
  /** Directory of bundled <id>.yml files used when nothing else is available. */
  bundledDir: string;
  /** Where the last good catalog is stored. Omit to disable caching. */
  cacheFile?: string;
  /** Running app version, compared against each entry's minAppVersion. */
  appVersion: string;
  /** How long a cached catalog is used before refresh() fetches again. */
  ttlMs?: number;
  /** Replaceable for tests and for the local-file override. */
  fetchText?: (url: string) => Promise<string>;
  now?: () => number;
}

interface ICacheFile {
  fetchedAt: number;
  schemaVersion: number;
  domains: Record<string, { container: IContainerCatalogEntry }>;
}

export const DEFAULT_CATALOG_TTL_MS = 60 * 60 * 1000;
const MAX_CATALOG_BYTES = 1024 * 1024;

/**
 * Hosted domains.json (apps.json repository's Cloudflare Worker). Empty until
 * it is published; until then the app uses its cache and bundled files only.
 */
export const DEFAULT_CATALOG_URL =
  'https://apps-json.scigetorg.workers.dev/domains.json';

export class ContainerCatalog {
  private readonly _options: IContainerCatalogOptions;
  private readonly _bundled: Map<string, IContainerCatalogEntry>;
  private _entries: Map<string, IContainerCatalogEntry>;
  private _source: CatalogSource;
  private _fetchedAt = 0;
  private _refreshing: Promise<void> | null = null;

  constructor(options: IContainerCatalogOptions) {
    this._options = options;
    this._bundled = this._loadBundled();

    const cached = this._readCache();
    if (cached && cached.entries.size > 0) {
      this._entries = cached.entries;
      this._fetchedAt = cached.fetchedAt;
      this._source = 'cache';
    } else {
      this._entries = new Map(this._bundled);
      this._source = 'bundled';
    }
  }

  /** Entries in ID order. */
  getEntries(): IContainerCatalogEntry[] {
    return [...this._entries.keys()].sort().map(id => this._entries.get(id));
  }

  getIds(): string[] {
    return [...this._entries.keys()].sort();
  }

  getEntry(id: string): IContainerCatalogEntry | undefined {
    return this._entries.get(id);
  }

  getSource(): CatalogSource {
    return this._source;
  }

  /**
   * Fetch the remote catalog if the current one is older than the TTL.
   * Concurrent calls share one fetch. Never rejects: on any failure the
   * current snapshot stays in place.
   */
  refresh(options: { force?: boolean } = {}): Promise<void> {
    if (!this._refreshing) {
      this._refreshing = this._refresh(options.force === true).finally(() => {
        this._refreshing = null;
      });
    }
    return this._refreshing;
  }

  private async _refresh(force: boolean): Promise<void> {
    const { url } = this._options;
    if (!url) {
      return;
    }
    const ttl = this._options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    if (
      !force &&
      this._source !== 'bundled' &&
      this._now() - this._fetchedAt < ttl
    ) {
      return;
    }

    let raw: unknown;
    try {
      const text = await (this._options.fetchText ?? defaultFetch)(url);
      raw = JSON.parse(text);
    } catch (error) {
      log.warn(
        `Container catalog fetch failed, keeping ${this._source}: ${error}`
      );
      return;
    }

    const document = parseCatalogDocument(raw);
    if (document.ok === false) {
      log.warn(
        `Container catalog rejected, keeping ${this._source}: ${document.error}`
      );
      return;
    }

    const candidates = new Map<string, IContainerCatalogEntry>();
    for (const [id, rawEntry] of Object.entries(document.entries)) {
      const entry = this._resolveEntry(id, rawEntry);
      if (entry) {
        candidates.set(id, entry);
      }
    }
    const resolved = withUniqueContainerNames(candidates, 'Remote');

    if (resolved.size === 0) {
      log.warn(
        `Container catalog has no usable entries, keeping ${this._source}`
      );
      return;
    }

    this._entries = resolved;
    this._source = 'remote';
    this._fetchedAt = this._now();
    this._writeCache();
    log.info(`Container catalog loaded ${resolved.size} entries from ${url}`);
  }

  private _resolveEntry(
    id: string,
    rawEntry: unknown
  ): IContainerCatalogEntry | null {
    const result = validateCatalogEntry(id, rawEntry);
    if (result.ok === true) {
      if (isEntryCompatible(result.entry, this._options.appVersion)) {
        return result.entry;
      }
      log.info(
        `Container ${id} needs app ${result.entry.minAppVersion}, running ${this._options.appVersion}`
      );
    } else {
      log.warn(`Container ${id} rejected: ${result.errors.join('; ')}`);
    }

    // The current snapshot (loaded from the cache, or a previous fetch) and
    // the bundle hold only entries already validated and checked for
    // compatibility with this app version.
    const fallback = this._entries.get(id) ?? this._bundled.get(id);
    if (fallback) {
      log.warn(`Container ${id}: using last known good entry`);
      return fallback;
    }
    return null;
  }

  private _acceptEntries(
    raw: Record<string, unknown>,
    origin: string
  ): Map<string, IContainerCatalogEntry> {
    const entries = new Map<string, IContainerCatalogEntry>();
    for (const [id, rawEntry] of Object.entries(raw)) {
      const result = validateCatalogEntry(id, rawEntry);
      if (result.ok === false) {
        log.warn(
          `${origin} container ${id} rejected: ${result.errors.join('; ')}`
        );
      } else if (isEntryCompatible(result.entry, this._options.appVersion)) {
        entries.set(id, result.entry);
      }
    }
    return withUniqueContainerNames(entries, origin);
  }

  private _loadBundled(): Map<string, IContainerCatalogEntry> {
    const raw: Record<string, unknown> = {};
    let files: string[] = [];
    try {
      files = fs.readdirSync(this._options.bundledDir);
    } catch (error) {
      log.error(`Cannot read bundled container configs: ${error}`);
    }
    for (const file of files) {
      const ext = path.extname(file);
      if (ext !== '.yml' && ext !== '.yaml') {
        continue;
      }
      try {
        const text = fs.readFileSync(
          path.join(this._options.bundledDir, file),
          'utf8'
        );
        raw[path.basename(file, ext)] = normalizeYamlEntry(yaml.load(text));
      } catch (error) {
        log.error(`Cannot parse bundled container config ${file}: ${error}`);
      }
    }
    return this._acceptEntries(raw, 'Bundled');
  }

  // The cache is re-validated on every read: it lives in a user-writable
  // directory, and the app may have been downgraded since it was written.
  private _readCache(): {
    entries: Map<string, IContainerCatalogEntry>;
    fetchedAt: number;
  } | null {
    const { cacheFile } = this._options;
    if (!cacheFile || !fs.existsSync(cacheFile)) {
      return null;
    }
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const document = parseCatalogDocument(data);
      if (document.ok === false || typeof data.fetchedAt !== 'number') {
        log.warn(`Ignoring corrupt container catalog cache at ${cacheFile}`);
        return null;
      }
      return {
        entries: this._acceptEntries(document.entries, 'Cached'),
        fetchedAt: data.fetchedAt
      };
    } catch (error) {
      log.warn(`Cannot read container catalog cache: ${error}`);
      return null;
    }
  }

  private _writeCache(): void {
    const { cacheFile } = this._options;
    if (!cacheFile) {
      return;
    }
    const data: ICacheFile = {
      fetchedAt: this._fetchedAt,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      domains: Object.fromEntries(
        [...this._entries].map(([id, entry]) => [id, { container: entry }])
      )
    };
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // Write then rename, so a crash mid-write never leaves a torn cache.
      const tmp = `${cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, cacheFile);
    } catch (error) {
      log.warn(`Cannot write container catalog cache: ${error}`);
    }
  }

  private _now(): number {
    return (this._options.now ?? Date.now)();
  }
}

/**
 * Two domains launching the same containerName would stop or reuse each
 * other's containers. Keep the first entry in ID order and drop the rest.
 */
function withUniqueContainerNames(
  entries: Map<string, IContainerCatalogEntry>,
  origin: string
): Map<string, IContainerCatalogEntry> {
  const owners = new Map<string, string>();
  const unique = new Map<string, IContainerCatalogEntry>();
  for (const id of [...entries.keys()].sort()) {
    const entry = entries.get(id);
    const owner = owners.get(entry.containerName);
    if (owner) {
      log.warn(
        `${origin} container ${id} dropped: containerName ${entry.containerName} is already used by ${owner}`
      );
      continue;
    }
    owners.set(entry.containerName, id);
    unique.set(id, entry);
  }
  return unique;
}

function defaultFetch(url: string): Promise<string> {
  return fetchText(url, { maxBytes: MAX_CATALOG_BYTES });
}

/**
 * YAML parses an unquoted 2026-09-23 as a Date; the catalog wants the tag
 * string. Trailing newlines from block scalars are trimmed.
 */
function normalizeYamlEntry(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const entry: Record<string, unknown> = { ...raw };
  if (entry.defaultVersion instanceof Date) {
    entry.defaultVersion = entry.defaultVersion.toISOString().split('T')[0];
  }
  if (typeof entry.description === 'string') {
    entry.description = entry.description.trim();
  }
  return entry;
}

export interface ICreateContainerCatalogOptions {
  appVersion: string;
  bundledDir: string;
  cacheDir: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the app's catalog. NEURODESK_CATALOG_URL points it at a test catalog:
 * an https URL, or a local file path. With an override the cache is neither
 * read nor written, so testing never leaves a test catalog behind.
 */
export function createContainerCatalog(
  options: ICreateContainerCatalogOptions
): ContainerCatalog {
  const override = (options.env ?? process.env).NEURODESK_CATALOG_URL;
  const base = {
    appVersion: options.appVersion,
    bundledDir: options.bundledDir
  };
  if (!override) {
    return new ContainerCatalog({
      ...base,
      url: DEFAULT_CATALOG_URL,
      cacheFile: path.join(options.cacheDir, 'container-catalog.json')
    });
  }
  if (override.startsWith('https://')) {
    return new ContainerCatalog({ ...base, url: override, ttlMs: 0 });
  }
  const filePath = path.resolve(override);
  return new ContainerCatalog({
    ...base,
    url: `file://${filePath}`,
    ttlMs: 0,
    fetchText: () => fs.promises.readFile(filePath, 'utf8')
  });
}
