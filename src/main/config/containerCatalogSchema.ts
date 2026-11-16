import * as semver from 'semver';
import { ContainerConfig } from './containerConfigParser';

// Validation for container catalog entries.
//
// Every field of an entry ends up in one of two dangerous places, so each is
// checked against a pattern that excludes the characters that could escape it:
//
//   registry, defaultVersion,        ──► generated launch shell/batch script
//   containerName, volumeMount,          (docker/podman run …)
//   defaultStorageMount
//
//   title, description, tags,        ──► welcome view innerHTML and inline
//   remoteUrl, releaseHistoryUrl         onclick='…' handlers
//
// Entries come from the `container` block of each domain in apps.json's
// domains.json. The same rules exist as JSON Schema in domains.schema.json,
// which the catalog repository's CI runs. container-catalog-schema.test.ts checks that
// the two agree; change both together.

export const CATALOG_SCHEMA_VERSION = 1;

/**
 * Catalog key. Each apps.json domain has its own image, so the key is the
 * domain ID (neuroimaging, microscopy): lowercase, starts with a letter,
 * single hyphens. It is also the containerConfigName a session launches.
 */
export const CONTAINER_ID_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
/** Docker image repository, optionally with a registry host and port. */
export const REGISTRY_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
/** Docker image tag. */
export const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** Docker container and volume names. */
export const DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** Same rule as validateStorageMount: a single directory name. */
export const STORAGE_MOUNT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const TITLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
export const TAG_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
/** Free text shown as HTML text content: no markup or entities. */
export const DESCRIPTION_PATTERN = /^[^<>&]{1,2000}$/;
/** https URL with no characters that could leave an HTML attribute or JS string. */
export const HTTPS_URL_PATTERN = /^https:\/\/[^\s"'<>`\\/]+(?:\/[^\s"'<>`\\]*)?$/;

export const MAX_REMOTE_URLS = 10;
export const MAX_TAGS = 20;

export interface IContainerCatalogEntry extends ContainerConfig {
  /** Oldest app version that can launch this entry. */
  minAppVersion?: string;
}

export type CatalogEntryResult =
  | { ok: true; entry: IContainerCatalogEntry }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !HTTPS_URL_PATTERN.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Validate one catalog entry and return a copy holding only known fields.
 *
 * Unknown fields are dropped rather than rejected, so an older app keeps
 * working when a newer catalog adds an optional field. The catalog repository's
 * CI is stricter and rejects unknown fields to catch typos.
 */
export function validateCatalogEntry(
  id: string,
  raw: unknown
): CatalogEntryResult {
  const errors: string[] = [];
  const fail = (field: string, rule: string) =>
    errors.push(`${id}.${field}: ${rule}`);

  if (!CONTAINER_ID_PATTERN.test(id)) {
    errors.push(`${id}: container ID must match ${CONTAINER_ID_PATTERN}`);
  }
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [...errors, `${id}: entry must be an object`] };
  }

  const requireMatch = (field: string, pattern: RegExp): string => {
    const value = raw[field];
    if (typeof value !== 'string' || !pattern.test(value)) {
      fail(field, `must be a string matching ${pattern}`);
      return '';
    }
    return value;
  };

  const entry: IContainerCatalogEntry = {
    title: requireMatch('title', TITLE_PATTERN),
    description: requireMatch('description', DESCRIPTION_PATTERN),
    registry: requireMatch('registry', REGISTRY_PATTERN),
    defaultVersion: requireMatch('defaultVersion', TAG_PATTERN),
    containerName: requireMatch('containerName', DOCKER_NAME_PATTERN),
    volumeMount: requireMatch('volumeMount', DOCKER_NAME_PATTERN),
    defaultStorageMount: requireMatch(
      'defaultStorageMount',
      STORAGE_MOUNT_PATTERN
    )
  };

  if (raw.releaseHistoryUrl !== undefined) {
    if (isHttpsUrl(raw.releaseHistoryUrl)) {
      entry.releaseHistoryUrl = raw.releaseHistoryUrl;
    } else {
      fail('releaseHistoryUrl', 'must be an https URL');
    }
  }

  if (raw.remoteUrl !== undefined) {
    const urls = raw.remoteUrl;
    if (
      Array.isArray(urls) &&
      urls.length <= MAX_REMOTE_URLS &&
      urls.every(isHttpsUrl)
    ) {
      entry.remoteUrl = [...urls];
    } else {
      fail(
        'remoteUrl',
        `must be a list of at most ${MAX_REMOTE_URLS} https URLs`
      );
    }
  }

  if (raw.tags !== undefined) {
    const tags = raw.tags;
    if (
      Array.isArray(tags) &&
      tags.length <= MAX_TAGS &&
      tags.every(t => typeof t === 'string' && TAG_LABEL_PATTERN.test(t))
    ) {
      entry.tags = [...tags];
    } else {
      fail('tags', `must be a list of at most ${MAX_TAGS} short labels`);
    }
  }

  if (raw.minAppVersion !== undefined) {
    if (
      typeof raw.minAppVersion === 'string' &&
      semver.valid(raw.minAppVersion)
    ) {
      entry.minAppVersion = raw.minAppVersion;
    } else {
      fail('minAppVersion', 'must be a semver version such as 2.1.0');
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, entry };
}

/**
 * Whether this app version can launch the entry. Prerelease and dev builds
 * count as their release version (2.2.0-beta.1 satisfies minAppVersion 2.2.0).
 */
export function isEntryCompatible(
  entry: IContainerCatalogEntry,
  appVersion: string
): boolean {
  if (!entry.minAppVersion) {
    return true;
  }
  const current = semver.coerce(appVersion);
  return current !== null && semver.gte(current, entry.minAppVersion);
}

export type CatalogDocumentResult =
  | { ok: true; entries: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Check the domains.json envelope and pull out each domain's container block.
 *
 *   { schemaVersion: 1,
 *     domains: { neuroimaging: { source_repositories: [...], container: {...} },
 *                microscopy:   { source_repositories: [...] } } }
 *       ──► { neuroimaging: {...} }      (a domain with no container is skipped)
 *
 * Entries are validated one at a time by the caller so that one bad entry
 * does not discard the rest. Other domain fields belong to the catalog
 * pipeline and are ignored.
 */
export function parseCatalogDocument(raw: unknown): CatalogDocumentResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'catalog must be a JSON object' };
  }
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `unsupported schemaVersion ${JSON.stringify(
        raw.schemaVersion
      )}, expected ${CATALOG_SCHEMA_VERSION}`
    };
  }
  if (!isPlainObject(raw.domains)) {
    return { ok: false, error: 'domains must be an object' };
  }
  const entries: Record<string, unknown> = {};
  for (const [id, domain] of Object.entries(raw.domains)) {
    if (!isPlainObject(domain)) {
      // Not skipped silently: validation rejects it and the caller falls
      // back to the last good entry for this ID.
      entries[id] = domain;
    } else if (domain.container !== undefined) {
      entries[id] = domain.container;
    }
  }
  return { ok: true, entries };
}
