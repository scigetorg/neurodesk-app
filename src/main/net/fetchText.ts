import { request as httpsRequest } from 'https';

export interface IFetchTextOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Reject a response body larger than this many bytes. */
  maxBytes?: number;
  /** Follow at most this many redirects. */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * GET a URL over HTTPS and resolve with the response body as text.
 *
 * Redirects are followed only to other https:// URLs, so a redirect can never
 * downgrade a fetch of remote configuration to plain HTTP.
 */
export function fetchText(
  url: string,
  options: IFetchTextOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      reject(new Error(`Refusing to fetch non-https URL: ${url}`));
      return;
    }

    const req = httpsRequest(url, { timeout: timeoutMs }, res => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (maxRedirects <= 0) {
          reject(new Error(`Too many redirects fetching ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        fetchText(next, {
          timeoutMs,
          maxBytes,
          maxRedirects: maxRedirects - 1
        }).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      let body = '';
      let bytes = 0;
      let aborted = false;
      res.on('data', chunk => {
        if (aborted) {
          return;
        }
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          aborted = true;
          req.destroy();
          reject(new Error(`Response from ${url} exceeds ${maxBytes} bytes`));
          return;
        }
        body += chunk;
      });
      res.on('end', () => {
        if (!aborted) {
          resolve(body);
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.end();
  });
}
