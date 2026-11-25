import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { clearSession, getSession, setSession } from '../services/session';
import LoginPage from './LoginPage';

const FROM = { pathname: '/projects', search: '?status=active' };

function renderLogin(state = { from: FROM }) {
  return render(
    <TestProviders initialEntries={[{ pathname: '/login', state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </TestProviders>,
  );
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status });
}

let fetchMock;

beforeEach(() => {
  clearSession();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('LoginPage', () => {
  it('lists the demo emails in development, but never a password', () => {
    vi.stubEnv('DEV', true);
    renderLogin();
    expect(screen.getByText(/admin@acme\.test, manager@acme\.test, lead@acme\.test, viewer@acme\.test/))
      .toBeInTheDocument();
    expect(screen.queryByText(/AcmeDemo/)).not.toBeInTheDocument();
  });

  it('shows no demo accounts in a production build', () => {
    vi.stubEnv('DEV', false);
    renderLogin();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
    expect(screen.queryByText(/Demo accounts/)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/acme\.test/);
    expect(document.body).not.toHaveTextContent(/AcmeDemo/);
  });

  it('validates before submitting and shows errors next to the fields', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Email/)).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Email/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs in and returns to the page the user was heading to', async () => {
    let respond;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/Email/), ' manager@acme.test ');
    await user.type(screen.getByLabelText(/Password/), 'AcmeDemo-2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Disabled while the request is in flight.
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByLabelText(/Email/)).toBeDisabled();

    respond(jsonResponse(200, {
      access_token: 'a',
      refresh_token: 'r',
      user: { id: 2, full_name: 'Morgan Manager', role: 'manager' },
    }));

    expect(await screen.findByTestId('location')).toHaveTextContent('/projects?status=active');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      email: 'manager@acme.test',
      password: 'AcmeDemo-2026',
    });
    expect(getSession().user.role).toBe('manager');
  });

  it('goes to the dashboard when there is no page to return to', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: 'a', refresh_token: 'r', user: { id: 1, full_name: 'V', role: 'viewer' },
    }));
    const user = userEvent.setup();
    renderLogin(null);

    await user.type(screen.getByLabelText(/Email/), 'viewer@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'pass-word');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('shows a server error in an alert and lets the user try again', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
    }));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/Email/), 'manager@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it.each([
    [700, 'Too many attempts. Try again in 12 minutes.'],
    [60, 'Too many attempts. Try again in 1 minute.'],
    [1, 'Too many attempts. Try again in 1 minute.'],
  ])('says how long to wait when sign-in is throttled (Retry-After %i)', async (seconds, message) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 'too_many_attempts', message: 'Too many attempts. Try again in 15 minutes.' },
    }), { status: 429, headers: { 'Retry-After': String(seconds) } }));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/Email/), 'manager@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it("falls back to the API's wording when the Retry-After header cannot be read", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, {
      error: { code: 'too_many_attempts', message: 'Too many attempts. Try again in 15 minutes.' },
    }));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/Email/), 'manager@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 15 minutes.');
  });

  it('moves focus to the error after a failed sign-in, each time (phase 6, F6)', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, {
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
    }));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/Email/), 'manager@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveFocus();
    expect(alert).toHaveAttribute('tabindex', '-1');

    // the same error again must be announced again
    await user.click(screen.getByLabelText(/Password/));
    expect(screen.getByRole('alert')).not.toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('says the session ended when a token failed or was revoked (phase 6, F5)', () => {
    setSession({ accessToken: 'a', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role: 'viewer' } });
    clearSession('expired');
    renderLogin();
    expect(screen.getByText('Your session ended. Sign in again.')).toBeInTheDocument();
  });

  it('says nothing of the kind after a deliberate sign-out or on a first visit (phase 6, F5)', () => {
    setSession({ accessToken: 'a', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role: 'viewer' } });
    clearSession();
    renderLogin();
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });

  it('replaces the session-ended note with the error when the next sign-in fails (phase 6, F5)', async () => {
    clearSession('expired');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, {
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect' },
    }));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText(/Email/), 'manager@acme.test');
    await user.type(screen.getByLabelText(/Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(screen.queryByText('Your session ended. Sign in again.')).not.toBeInTheDocument();
  });

  it('limits the password input to 128 characters (phase 6, F9)', () => {
    renderLogin();
    expect(screen.getByLabelText(/Password/)).toHaveAttribute('maxlength', '128');
  });
});
