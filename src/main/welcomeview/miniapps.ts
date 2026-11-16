import { IContainerCatalogEntry } from '../config/containerCatalogSchema';

/** What the welcome page needs to show and launch one container. */
export interface IMiniApp {
  /** Catalog (domain) ID; the containerConfigName a local session launches. */
  id: string;
  /**
   * miniAppId sent to telemetry. Derived from the title, as before the
   * catalog existed, so existing dashboards keep counting the same apps.
   */
  telemetryId: string;
  title: string;
  description: string;
  defaultVersion: string;
  releaseHistoryUrl?: string;
  remoteUrl: string[];
  tags?: string[];
}

export function toMiniApp(id: string, entry: IContainerCatalogEntry): IMiniApp {
  const app: IMiniApp = {
    id,
    telemetryId: entry.title.toLowerCase().replace(/[^a-z0-9]/g, '-'),
    title: entry.title,
    description: entry.description || '',
    defaultVersion: entry.defaultVersion,
    remoteUrl: entry.remoteUrl || []
  };
  if (entry.releaseHistoryUrl) {
    app.releaseHistoryUrl = entry.releaseHistoryUrl;
  }
  if (entry.tags) {
    app.tags = entry.tags;
  }
  return app;
}

export function toMiniApps(
  entries: { id: string; entry: IContainerCatalogEntry }[]
): IMiniApp[] {
  return entries.map(({ id, entry }) => toMiniApp(id, entry));
}

/**
 * JSON safe to place inside an inline <script>: no string in it can close
 * the script element or start an HTML comment, and U+2028/U+2029 (line
 * terminators in older JavaScript) are escaped.
 */
export function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
