import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import TestProviders from './TestProviders';
import { clearSession, getSession, setSession } from './services/session';

// Unlike the page tests, these run the real API client against a stubbed fetch, so an expired
// access token goes through the client's refresh-and-retry exactly as it does in the browser.

const PROJECT = {
  id: 1,
  name: 'Customer Portal Revamp',
  department: 'Digital',
  status: 'active',
  start_date: '2026-01-01',
  end_date: '2099-12-31',
  budget_planned: 1000,
  budget_spent: 100,
  percent_complete: 50,
  owner_name: 'Maria Gonzalez',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const EXPIRED = json(401, { error: { code: 'token_expired', message: 'Token has expired', details: [] } });

/** Routes fetch by path: only the access token "fresh" is accepted; `refresh` answers /auth/refresh. */
function stubApi(refresh) {
  const fetchMock = vi.fn(async (url, init) => {
    const { pathname } = new URL(url, window.location.origin);
    if (pathname.endsWith('/auth/refresh')) return refresh();
    if (init.headers.Authorization !== 'Bearer fresh') return EXPIRED.clone();
    const items = pathname.endsWith('/projects') ? [PROJECT] : [];
    return json(200, { items, total: items.length, limit: 10, offset: 0 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function refreshCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith('/auth/refresh'));
}

beforeEach(() => {
  clearSession();
  setSession({
    accessToken: 'expired',
    refreshToken: 'refresh-1',
    user: { id: 2, full_name: 'Morgan Manager', role: 'manager' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an expired session', () => {
  it('is refreshed once and the page loads with the new token', async () => {
    const fetchMock = stubApi(() => json(200, {
      access_token: 'fresh',
      refresh_token: 'refresh-2',
      user: { id: 2, full_name: 'Morgan Manager', role: 'manager' },
    }));

    render(<TestProviders initialEntries={['/projects']}><AppRoutes /></TestProviders>);

    expect(await screen.findByRole('link', { name: 'Customer Portal Revamp' })).toBeInTheDocument();
    expect(refreshCalls(fetchMock)).toHaveLength(1);
    expect(getSession()).toMatchObject({ accessToken: 'fresh', refreshToken: 'refresh-2' });
  });

  it('signs the user out to the sign-in page when the refresh is refused', async () => {
    const fetchMock = stubApi(() => json(401, {
      error: { code: 'invalid_token', message: 'This account no longer exists or is inactive', details: [] },
    }));

    render(<TestProviders initialEntries={['/projects']}><AppRoutes /></TestProviders>);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(getSession()).toBeNull();
    expect(refreshCalls(fetchMock).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Customer Portal Revamp' })).not.toBeInTheDocument();
  });
});
