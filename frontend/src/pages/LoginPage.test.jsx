import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { clearSession, getSession } from '../services/session';
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

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('lists the demo emails but never a password', () => {
    renderLogin();
    expect(screen.getByText(/admin@acme\.test, manager@acme\.test, lead@acme\.test, viewer@acme\.test/))
      .toBeInTheDocument();
    expect(screen.queryByText(/AcmeDemo/)).not.toBeInTheDocument();
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
});
