import { CaptureError } from './errors.mjs';

export function parseHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new CaptureError('INVALID_URL', 'Enter a website URL.');
  let input = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;
  let url;
  try { url = new URL(input); } catch { throw new CaptureError('INVALID_URL', 'Enter a valid website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new CaptureError('INVALID_URL', 'Use HTTP or HTTPS without embedded credentials.');
  }
  return url;
}

export function urlKey(value) {
  // Preserve path slashes, queries and fragments; servers and SPA routers can use all three.
  return parseHttpUrl(value).href;
}

export function inScope(value, startUrl, scopePath = '/') {
  const url = parseHttpUrl(value);
  const start = parseHttpUrl(startUrl);
  const root = scopePath.replace(/\/+$/, '') || '/';
  return url.origin === start.origin && (root === '/' || url.pathname === root || url.pathname.startsWith(`${root}/`));
}

export function displayUrl(value) {
  const url = parseHttpUrl(value);
  // Output omits all query values/fragments rather than guessing secret parameter names.
  return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}${url.hash ? '#[redacted]' : ''}`;
}
