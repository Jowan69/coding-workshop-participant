/**
 * Non-hash URLs. The app routes by hash (/#/projects/5), but people type and share plain
 * paths (/projects/5). CloudFront answers any path without a file extension with index.html
 * (infra/spa-rewrite.js); this then moves the path into the hash, where the router reads it.
 */

/**
 * The hash URL a plain path should become, or null when there is nothing to change: the
 * root, a file such as /index.html, or a URL that already carries a hash route.
 *
 * @param {{pathname: string, search: string, hash: string}} location The page's location.
 * @returns {string|null} E.g. "/#/projects/5?tab=team".
 */
export function hashUrlFor({ pathname, search, hash }) {
  if (hash && hash !== '#') return null;
  if (!pathname || pathname === '/' || /\.[A-Za-z0-9]+$/.test(pathname)) return null;
  return `/#${pathname}${search ?? ''}`;
}

/**
 * Replace a plain path with its hash route, without reloading and without adding a history
 * entry. Call it before the router starts.
 *
 * @param {Window} [win] The window (for tests).
 * @returns {string|null} The new URL, or null when nothing changed.
 */
export function redirectPathToHash(win = window) {
  const target = hashUrlFor(win.location);
  if (target) win.history.replaceState(null, '', target);
  return target;
}
