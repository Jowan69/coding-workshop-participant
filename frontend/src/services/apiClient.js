import { clearSession, getSession, setSession } from './session';

/** Base URL of the tracker API: CloudFront in AWS, the dev proxy locally. */
export const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api/tracker`;

/** Paths that must never trigger a token refresh (they are how tokens are obtained). */
const TOKEN_PATHS = new Set(['/auth/login', '/auth/refresh']);

const DEFAULT_MESSAGES = {
  400: 'The request was not valid.',
  401: 'Please sign in again.',
  403: 'You do not have permission to do that.',
  404: 'That record was not found.',
  409: 'That conflicts with existing data.',
  429: 'Too many attempts. Try again later.',
};
const SERVER_ERROR_MESSAGE = 'Something went wrong on the server. Please try again.';
const NETWORK_ERROR_MESSAGE = 'Cannot reach the server. Check your connection and try again.';
const TIMEOUT_MESSAGE = 'The server took too long to answer. Try again.';

/**
 * How long a request may take. A paused Aurora Serverless database can need most of this to
 * resume, and without a limit a request could leave a screen loading for ever.
 */
export const REQUEST_TIMEOUT_MS = 30000;

/** An API failure in one shape: HTTP status, API error code, message and per-field errors. */
export class ApiError extends Error {
  /**
   * @param {object} options Error fields.
   * @param {number} options.status HTTP status, 0 for network failures.
   * @param {string} options.code API error code, e.g. "validation_error".
   * @param {string} options.message Human-readable message.
   * @param {Object<string, string>} [options.fieldErrors] First message per field.
   * @param {number|null} [options.retryAfter] Seconds to wait, from a Retry-After header.
   */
  constructor({ status, code, message, fieldErrors = {}, retryAfter = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.retryAfter = retryAfter;
  }
}

/**
 * Build the full URL for an API path, dropping empty query values.
 *
 * @param {string} path Path under /api/tracker, e.g. "/projects".
 * @param {Object<string, *>} [query] Query parameters.
 * @returns {string} Absolute or root-relative URL.
 */
export function buildUrl(path, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.append(key, String(value));
  });
  const search = params.toString();
  return `${API_BASE}${path}${search ? `?${search}` : ''}`;
}

/**
 * A new Idempotency-Key: with it a POST runs once on the server however often it is sent.
 *
 * @returns {string} A random key the API accepts (8 to 128 of A-Z a-z 0-9 _ -).
 */
export function createIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // randomUUID needs a secure context; getRandomValues does not.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function send(path, { method = 'GET', body, query, signal, idempotencyKey } = {}, token = null) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey ?? createIdempotencyKey();

  // One controller aborts the fetch for either reason: the caller's signal, or the timeout.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortWithCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortWithCaller, { once: true });

  try {
    return await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new ApiError({ status: 0, code: 'timeout', message: TIMEOUT_MESSAGE });
    if (error?.name === 'AbortError') throw error;
    throw new ApiError({ status: 0, code: 'network_error', message: NETWORK_ERROR_MESSAGE });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortWithCaller);
  }
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Turn a failed response into an ApiError, from the API's error shape when present.
 *
 * @param {Response} response A non-2xx fetch response.
 * @returns {Promise<ApiError>} The normalised error.
 */
export async function toApiError(response) {
  const error = (await parseBody(response))?.error ?? {};
  const fieldErrors = {};
  (Array.isArray(error.details) ? error.details : []).forEach(({ field, message }) => {
    if (field && message && !fieldErrors[field]) fieldErrors[field] = message;
  });
  const fallback = DEFAULT_MESSAGES[response.status] ?? SERVER_ERROR_MESSAGE;
  const retryAfter = Number(response.headers?.get?.('Retry-After'));
  return new ApiError({
    status: response.status,
    code: error.code ?? `http_${response.status}`,
    message: error.message ?? fallback,
    fieldErrors,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  });
}

/**
 * Store the session a token response carries (login, refresh, change-password).
 *
 * @param {{access_token: string, refresh_token: string, user: object}} data Token response.
 */
export function storeTokens(data) {
  setSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  });
}

/** The API says this user must replace a temporary password: make the session say so too. */
function requirePasswordChange() {
  const session = getSession();
  if (session?.user && !session.user.must_change_password) {
    setSession({ ...session, user: { ...session.user, must_change_password: true } });
  }
}

let refreshInFlight = null;

/**
 * Exchange the refresh token for new tokens. Concurrent callers share one request.
 * Resolves true on success and false when the API refused the refresh token.
 */
function refreshTokens() {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = getSession()?.refreshToken;
      if (!refreshToken) return false;
      const response = await send('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
      });
      if (!response.ok) return false;
      storeTokens(await response.json());
      return true;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Call the tracker API. Attaches the access token; on a 401 refreshes the tokens once and
 * retries, and signs the user out if that fails. A request that gets no answer within 30
 * seconds is aborted and reported as a timeout the user can retry.
 *
 * @param {string} path Path under /api/tracker, e.g. "/projects/3".
 * @param {object} [options] Request options.
 * @param {string} [options.method] HTTP method, GET by default.
 * @param {*} [options.body] JSON body.
 * @param {Object<string, *>} [options.query] Query parameters; empty values are dropped.
 * @param {AbortSignal} [options.signal] Cancels the request.
 * @param {string} [options.idempotencyKey] POST only: the Idempotency-Key to send. Pass the
 *   same key again to retry without running the request twice; one is made up otherwise.
 * @returns {Promise<*>} Parsed JSON body, or null for 204 and empty bodies.
 * @throws {ApiError} For HTTP errors and network failures.
 */
export async function request(path, given = {}) {
  // One key per call, so the retry after a token refresh repeats the same request.
  const options = given.method === 'POST' && !given.idempotencyKey
    ? { ...given, idempotencyKey: createIdempotencyKey() }
    : given;
  const usedToken = getSession()?.accessToken ?? null;
  let response = await send(path, options, usedToken);

  if (response.status === 401 && usedToken && !TOKEN_PATHS.has(path)) {
    // Another request may have refreshed already; otherwise refresh now.
    const latest = getSession()?.accessToken;
    const refreshed = (latest && latest !== usedToken) || (await refreshTokens());
    if (refreshed) response = await send(path, options, getSession()?.accessToken);
    // The token failed or was revoked and could not be renewed: the sign-in page says so.
    if (response.status === 401) clearSession('expired');
  }

  if (response.status === 204) return null;
  if (!response.ok) {
    const error = await toApiError(response);
    if (error.code === 'password_change_required') requirePasswordChange();
    throw error;
  }
  const data = await parseBody(response);
  if (data === undefined) {
    throw new ApiError({
      status: response.status,
      code: 'invalid_response',
      message: 'The server sent an unexpected response.',
    });
  }
  return data;
}

/**
 * Sign in and store the session.
 *
 * @param {string} email User email.
 * @param {string} password User password.
 * @returns {Promise<object>} The signed-in user.
 * @throws {ApiError} invalid_credentials, account_inactive, validation or network errors.
 */
export async function login(email, password) {
  const data = await request('/auth/login', { method: 'POST', body: { email, password } });
  storeTokens(data);
  return data.user;
}
