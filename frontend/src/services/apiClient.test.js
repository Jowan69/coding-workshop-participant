import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE, ApiError, REQUEST_TIMEOUT_MS, buildUrl, createIdempotencyKey, login, request,
} from './apiClient';
import { clearSession, getSession, getSessionEndReason, setSession } from './session';

const USER = { id: 1, email: 'manager@acme.test', full_name: 'Morgan Manager', role: 'manager' };

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function signIn(accessToken = 'access-1', refreshToken = 'refresh-1') {
  setSession({ accessToken, refreshToken, user: USER });
}

function authHeader(call) {
  return call[1].headers.Authorization;
}

let fetchMock;

beforeEach(() => {
  clearSession();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildUrl', () => {
  it('prefixes the API base and drops empty query values', () => {
    const url = buildUrl('/projects', { q: 'bank', status: '', department: null, limit: 25 });
    expect(url).toBe(`${API_BASE}/projects?q=bank&limit=25`);
  });
});

describe('request', () => {
  it('attaches the access token and parses JSON', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], total: 0 }));

    const data = await request('/projects', { query: { q: 'x' } });

    expect(data).toEqual({ items: [], total: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/projects?q=x`);
    expect(init.method).toBe('GET');
    expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer access-1');
  });

  it('sends a JSON body with its content type', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 9 }));

    await request('/projects', { method: 'POST', body: { name: 'New' } });

    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"name":"New"}');
  });

  it('refreshes once on a 401, stores the new tokens and retries', async () => {
    signIn('expired', 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_expired', message: 'Token expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: 'access-2', refresh_token: 'refresh-2', user: { ...USER, role: 'admin' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 3 }));

    const data = await request('/projects/3');

    expect(data).toEqual({ id: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1];
    expect(refreshUrl).toBe(`${API_BASE}/auth/refresh`);
    expect(JSON.parse(refreshInit.body)).toEqual({ refresh_token: 'refresh-1' });
    expect(authHeader(fetchMock.mock.calls[2])).toBe('Bearer access-2');
    expect(getSession()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(getSession().user.role).toBe('admin');
  });

  it('shares one refresh between concurrent 401s', async () => {
    signIn('expired', 'refresh-1');
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, { access_token: 'fresh', refresh_token: 'r2', user: USER });
      }
      return init.headers.Authorization === 'Bearer fresh'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { error: { code: 'token_expired', message: 'Token expired' } });
    });

    await Promise.all([request('/projects'), request('/resources')]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('signs out when the refresh is refused', async () => {
    signIn('expired', 'revoked');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_expired', message: 'Token expired' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'invalid_token', message: 'Invalid token' } }));

    await expect(request('/projects')).rejects.toMatchObject({ status: 401, code: 'token_expired' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getSession()).toBeNull();
  });

  it('does not refresh when signing in fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
    }));

    await expect(login('a@acme.test', 'wrong')).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: 'Email or password is incorrect',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalises API errors, including field errors', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error: {
        code: 'validation_error',
        message: 'Validation failed',
        details: [
          { field: 'end_date', message: 'must be on or after start_date' },
          { field: 'name', message: 'is required' },
          { field: 'name', message: 'second message is ignored' },
        ],
      },
    }));

    const error = await request('/projects', { method: 'POST', body: {} }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'validation_error', message: 'Validation failed' });
    expect(error.fieldErrors).toEqual({
      end_date: 'must be on or after start_date',
      name: 'is required',
    });
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(request('/projects')).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
      message: 'Something went wrong on the server. Please try again.',
    });
  });

  it('returns null for 204 No Content', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(request('/projects/1', { method: 'DELETE' })).resolves.toBeNull();
  });

  it('turns network failures into a network_error', async () => {
    signIn();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(request('/projects')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: expect.stringMatching(/cannot reach the server/i),
    });
    expect(getSession()).not.toBeNull();
  });

  it('lets aborted requests reject as AbortError', async () => {
    signIn();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    await expect(request('/projects')).rejects.toHaveProperty('name', 'AbortError');
  });

  it('signs out when the retry is still refused after a successful refresh', async () => {
    signIn('expired', 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_expired', message: 'Token expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', user: USER }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'invalid_token', message: 'Token is invalid' } }));

    await expect(request('/projects')).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getSession()).toBeNull();
  });

  it('keeps the session when the refresh cannot reach the server', async () => {
    signIn('expired', 'refresh-1');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_expired', message: 'Token expired' } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(request('/projects')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    expect(getSession()).toMatchObject({ accessToken: 'expired', refreshToken: 'refresh-1' });
  });

  it('does not try to refresh when no one is signed in', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: 'missing_token', message: 'Token required' } }));

    await expect(request('/projects')).rejects.toMatchObject({ status: 401, code: 'missing_token' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('rejects a successful response whose body is not JSON', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(new Response('<html>index</html>', { status: 200 }));

    await expect(request('/projects')).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('maps each error status to a readable default when the body has no message', async () => {
    signIn();
    const expected = {
      400: /not valid/, 403: /permission/, 404: /not found/, 409: /conflicts/,
    };
    for (const [status, message] of Object.entries(expected)) {
      fetchMock.mockResolvedValueOnce(new Response('', { status: Number(status) }));
      await expect(request('/projects')).rejects.toMatchObject({
        status: Number(status), code: `http_${status}`, message: expect.stringMatching(message),
      });
    }
  });
});

describe('request: throttling and temporary passwords (phase 6, part B)', () => {
  it('reads Retry-After into the error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'too_many_attempts', message: 'Too many attempts. Try again in 15 minutes.' },
    }), { status: 429, headers: { 'Retry-After': '840' } }));

    await expect(request('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 429, code: 'too_many_attempts', retryAfter: 840,
    });
  });

  it('leaves retryAfter empty without the header and has a default 429 message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(request('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 429, retryAfter: null, message: 'Too many attempts. Try again later.',
    });
  });

  it('marks the session when the API says the password must be changed first', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(403, {
      error: { code: 'password_change_required', message: 'Change your temporary password before doing anything else' },
    }));

    await expect(request('/projects')).rejects.toMatchObject({ status: 403, code: 'password_change_required' });

    expect(getSession().user.must_change_password).toBe(true);
    expect(getSession().accessToken).toBe('access-1');
  });

  it('leaves the session alone on an ordinary 403', async () => {
    signIn();
    const before = getSession();
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { code: 'forbidden', message: 'No' } }));
    await expect(request('/auth/users')).rejects.toMatchObject({ status: 403 });
    expect(getSession()).toBe(before);
  });
});

describe('idempotency keys (phase 6, D2)', () => {
  const keyOf = (call) => call[1].headers['Idempotency-Key'];

  it('sends an Idempotency-Key on every POST and on no other method', async () => {
    signIn();
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));

    await request('/projects', { method: 'POST', body: { name: 'A' } });
    await request('/projects', { method: 'POST', body: { name: 'B' } });
    await request('/projects');
    await request('/projects/1', { method: 'PUT', body: { name: 'C' } });
    await request('/projects/1', { method: 'DELETE' });

    const [first, second, get, put, del] = fetchMock.mock.calls.map(keyOf);
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(second).not.toBe(first);
    expect([get, put, del]).toEqual([undefined, undefined, undefined]);
  });

  it('uses the key it is given', async () => {
    signIn();
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
    await request('/projects', { method: 'POST', body: {}, idempotencyKey: 'form-open-0001' });
    expect(keyOf(fetchMock.mock.calls[0])).toBe('form-open-0001');
  });

  it('repeats the same key when it retries after refreshing the token', async () => {
    signIn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'access-2', refresh_token: 'refresh-2', user: USER }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 9 }));

    await request('/projects', { method: 'POST', body: { name: 'Once' } });

    const [first, refresh, retry] = fetchMock.mock.calls;
    expect(keyOf(first)).toBeTruthy();
    expect(keyOf(retry)).toBe(keyOf(first));
    expect(keyOf(refresh)).toBeTruthy();
    expect(keyOf(refresh)).not.toBe(keyOf(first));
  });

  it('sends a key when signing in too', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'a', refresh_token: 'r', user: USER }));
    await login('manager@acme.test', 'secret-pass');
    expect(keyOf(fetchMock.mock.calls[0])).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('makes valid keys with and without crypto.randomUUID', () => {
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(createIdempotencyKey()).not.toBe(createIdempotencyKey());
    // Outside a secure context browsers have no randomUUID: shadow it for this check.
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const key = createIdempotencyKey();
      expect(key).toMatch(/^[0-9a-f]{32}$/);
      expect(createIdempotencyKey()).not.toBe(key);
    } finally {
      delete globalThis.crypto.randomUUID;
    }
    expect(typeof globalThis.crypto.randomUUID).toBe('function');
  });
});

describe('request timeout (phase 6, F8)', () => {
  /** A fetch that never answers, but rejects like the browser does when its signal aborts. */
  function hangingFetch() {
    return vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort);
    }));
  }

  afterEach(() => vi.useRealTimers());

  it('gives up after 30 seconds with a message the user can act on', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    expect(REQUEST_TIMEOUT_MS).toBe(30000);

    const outcome = request('/projects').catch((error) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 0, code: 'timeout', message: 'The server took too long to answer. Try again.',
    });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('works again when the user retries', async () => {
    vi.useFakeTimers();
    const slow = hangingFetch();
    vi.stubGlobal('fetch', slow);
    const first = request('/projects').catch((error) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect((await first).code).toBe('timeout');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { items: [] })));
    await expect(request('/projects')).resolves.toEqual({ items: [] });
  });

  it('stops the clock once the server has answered', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    await request('/projects');
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2);
    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still lets the caller cancel, as an AbortError and not a timeout', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    const outcome = request('/projects', { signal: controller.signal }).catch((error) => error);
    controller.abort();
    const error = await outcome;
    expect(error.name).toBe('AbortError');
    expect(error).not.toBeInstanceOf(ApiError);
  });

  it('does not start a request the caller already cancelled', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();
    controller.abort();
    const error = await request('/projects', { signal: controller.signal }).catch((e) => e);
    expect(error.name).toBe('AbortError');
  });

  it('times out a POST too, without sending it twice', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const outcome = request('/projects', { method: 'POST', body: { name: 'Slow' } }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect((await outcome).code).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('why a session ended (phase 6, F5)', () => {
  it('records that the session expired when the refresh is refused', async () => {
    signIn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_revoked' } }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'token_revoked' } }));
    await expect(request('/projects')).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
    expect(getSessionEndReason()).toBe('expired');
  });

  it('records no reason for a deliberate sign-out, and forgets the reason at the next sign-in', async () => {
    signIn();
    clearSession('expired');
    expect(getSessionEndReason()).toBe('expired');
    signIn();
    expect(getSessionEndReason()).toBeNull();
    clearSession();
    expect(getSessionEndReason()).toBeNull();
  });
});

describe('login', () => {
  it('stores the tokens and returns the user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 1800, user: USER,
    }));

    const user = await login('manager@acme.test', 'secret-pass');

    expect(user).toEqual(USER);
    expect(getSession()).toEqual({ accessToken: 'a', refreshToken: 'r', user: USER });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
