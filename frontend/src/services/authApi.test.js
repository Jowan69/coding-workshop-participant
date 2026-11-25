import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from './apiClient';
import { changePassword, signOut } from './authApi';
import { clearSession, getSession, setSession } from './session';

const USER = { id: 4, full_name: 'Tom Becker', role: 'viewer', must_change_password: false };

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

let fetchMock;

beforeEach(() => {
  clearSession();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('signOut', () => {
  it('asks the API to end the sessions, then clears storage', async () => {
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1', user: USER });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await signOut();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/auth/logout`);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer access-1');
    expect(getSession()).toBeNull();
    expect(window.sessionStorage.getItem('acme.session')).toBeNull();
  });

  it.each([
    ['the API fails', () => Promise.resolve(jsonResponse(500, { error: { code: 'internal_error' } }))],
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the token was already revoked', () => Promise.resolve(jsonResponse(401, { error: { code: 'token_revoked' } }))],
  ])('still clears storage when %s', async (_name, answer) => {
    setSession({ accessToken: 'access-1', refreshToken: 'refresh-1', user: USER });
    fetchMock.mockImplementation(answer);

    await expect(signOut()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });

  it('makes no request when nobody is signed in', async () => {
    await signOut();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });
});

describe('changePassword', () => {
  it('sends both passwords and replaces the session with the fresh tokens', async () => {
    setSession({ accessToken: 'old-access', refreshToken: 'old-refresh', user: { ...USER, must_change_password: true } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 1800, user: USER,
    }));

    const user = await changePassword('Old-Pass-123', 'Tangerine-Sky-42');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/auth/change-password`);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer old-access');
    expect(JSON.parse(options.body)).toEqual({ current_password: 'Old-Pass-123', new_password: 'Tangerine-Sky-42' });
    expect(user).toEqual(USER);
    expect(getSession()).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh', user: USER });
  });

  it('keeps the session and reports the field when the current password is wrong', async () => {
    const session = { accessToken: 'old-access', refreshToken: 'old-refresh', user: USER };
    setSession(session);
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {
      error: {
        code: 'validation_error',
        message: 'Validation failed',
        details: [{ field: 'current_password', message: 'is incorrect' }],
      },
    }));

    await expect(changePassword('wrong', 'Tangerine-Sky-42')).rejects.toMatchObject({
      status: 400, fieldErrors: { current_password: 'is incorrect' },
    });
    expect(getSession()).toEqual(session);
  });
});
