import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../services/session';
import { AuthProvider } from './AuthContext';
import { useAuth } from './auth-context';

const ACTIONS = ['read', 'write', 'delete', 'manageUsers'];

function Probe() {
  const { user, role, isAuthenticated, can, login, logout } = useAuth();
  return (
    <div>
      <p data-testid="state">{isAuthenticated ? `${user.full_name} (${role})` : 'signed out'}</p>
      <p data-testid="can">{ACTIONS.filter((action) => can(action)).join(',')}</p>
      <button type="button" onClick={() => login('admin@acme.test', 'secret-pass')}>login</button>
      <button type="button" onClick={logout}>logout</button>
    </div>
  );
}

function renderProbe() {
  return render(<AuthProvider><Probe /></AuthProvider>);
}

beforeEach(() => clearSession());
afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider', () => {
  it.each([
    ['viewer', 'read'],
    ['contributor', 'read,write'],
    ['manager', 'read,write,delete'],
    ['admin', 'read,write,delete,manageUsers'],
  ])('gives a %s these permissions: %s', (role, allowed) => {
    setSession({ accessToken: 'a', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role } });
    renderProbe();
    expect(screen.getByTestId('state')).toHaveTextContent(`Pat (${role})`);
    expect(screen.getByTestId('can')).toHaveTextContent(new RegExp(`^${allowed}$`));
  });

  it('allows nothing when signed out', () => {
    renderProbe();
    expect(screen.getByTestId('state')).toHaveTextContent('signed out');
    expect(screen.getByTestId('can')).toBeEmptyDOMElement();
  });

  it('signs in through the API and signs out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'a', refresh_token: 'r', user: { id: 1, full_name: 'Ada Admin', role: 'admin' },
    }), { status: 200 })));
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole('button', { name: 'login' }));
    expect(await screen.findByText('Ada Admin (admin)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'logout' }));
    expect(screen.getByTestId('state')).toHaveTextContent('signed out');
  });

  it('follows session changes made by the API client (refresh, forced sign-out)', () => {
    setSession({ accessToken: 'a', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role: 'viewer' } });
    renderProbe();

    act(() => setSession({ accessToken: 'b', refreshToken: 'r2', user: { id: 1, full_name: 'Pat', role: 'manager' } }));
    expect(screen.getByTestId('state')).toHaveTextContent('Pat (manager)');

    act(() => clearSession());
    expect(screen.getByTestId('state')).toHaveTextContent('signed out');
  });
});
