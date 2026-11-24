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
};
const SERVER_ERROR_MESSAGE = 'Something went wrong on the server. Please try again.';
const NETWORK_ERROR_MESSAGE = 'Cannot reach the server. Check your connection and try again.';

/** An API failure in one shape: HTTP status, API error code, message and per-field errors. */
export class ApiError extends Error {
  /**
   * @param {object} options Error fields.
   * @param {number} options.status HTTP status, 0 for network failures.
   * @param {string} options.code API error code, e.g. "validation_error".
   * @param {string} options.message Human-readable message.
   * @param {Object<string, string>} [options.fieldErrors] First message per field.
   */
  constructor({ status, code, message, fieldErrors = {} }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
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

async function send(path, { method = 'GET', body, query, signal } = {}, token = null) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError({ status: 0, code: 'network_error', message: NETWORK_ERROR_MESSAGE });
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
  return new ApiError({
    status: response.status,
    code: error.code ?? `http_${response.status}`,
    message: error.message ?? fallback,
    fieldErrors,
  });
}

function storeTokens(data) {
  setSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  });
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
 * retries, and signs the user out if that fails.
 *
 * @param {string} path Path under /api/tracker, e.g. "/projects/3".
 * @param {object} [options] Request options.
 * @param {string} [options.method] HTTP method, GET by default.
 * @param {*} [options.body] JSON body.
 * @param {Object<string, *>} [options.query] Query parameters; empty values are dropped.
 * @param {AbortSignal} [options.signal] Cancels the request.
 * @returns {Promise<*>} Parsed JSON body, or null for 204 and empty bodies.
 * @throws {ApiError} For HTTP errors and network failures.
 */
export async function request(path, options = {}) {
  const usedToken = getSession()?.accessToken ?? null;
  let response = await send(path, options, usedToken);

  if (response.status === 401 && usedToken && !TOKEN_PATHS.has(path)) {
    // Another request may have refreshed already; otherwise refresh now.
    const latest = getSession()?.accessToken;
    const refreshed = (latest && latest !== usedToken) || (await refreshTokens());
    if (refreshed) response = await send(path, options, getSession()?.accessToken);
    if (response.status === 401) clearSession();
  }

  if (response.status === 204) return null;
  if (!response.ok) throw await toApiError(response);
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

/** Sign out by forgetting the tokens. The API keeps no server-side session. */
export function logout() {
  clearSession();
}
