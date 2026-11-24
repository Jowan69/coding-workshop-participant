/**
 * The signed-in session: access token, refresh token and the user they belong to.
 *
 * Storage trade-off: the session lives in sessionStorage. Any script running on the page (an
 * XSS bug) could read it, which an httpOnly cookie would prevent. But the API is a Lambda
 * Function URL on another origin that takes a Bearer header and sets no cookies, so a cookie
 * is not available without backend and CloudFront changes. sessionStorage at least ends with
 * the tab, is not sent automatically (no CSRF), and is not shared between tabs. The access
 * token lasts 30 minutes; the refresh token 7 days.
 */

const STORAGE_KEY = 'acme.session';
const listeners = new Set();

function readStored() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let current = readStored();

function notify() {
  listeners.forEach((listener) => listener(current));
}

/**
 * The current session, or null when signed out. The object is replaced, never mutated, so it
 * is safe as a useSyncExternalStore snapshot.
 *
 * @returns {{accessToken: string, refreshToken: string, user: object}|null} Session.
 */
export function getSession() {
  return current;
}

/**
 * Store a new session and notify subscribers.
 *
 * @param {{accessToken: string, refreshToken: string, user: object}} session New session.
 */
export function setSession(session) {
  current = session;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked (private mode, quota): keep the session in memory for this page load.
  }
  notify();
}

/** Forget the session and notify subscribers. */
export function clearSession() {
  current = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored or storage blocked: the in-memory session is already gone.
  }
  notify();
}

/**
 * Listen for session changes (sign-in, token refresh, sign-out).
 *
 * @param {(session: object|null) => void} listener Called with the new session.
 * @returns {() => void} Unsubscribe function.
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
