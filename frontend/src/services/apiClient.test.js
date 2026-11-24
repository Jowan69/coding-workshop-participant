import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_BASE, ApiError, buildUrl, login, request,
} from './apiClient';
import { clearSession, getSession, setSession } from './session';

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
