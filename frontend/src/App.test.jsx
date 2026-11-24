import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import TestProviders from './TestProviders';
import { request } from './services/apiClient';
import { clearSession, getSession, setSession } from './services/session';

vi.mock('./services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

function signInAs(role) {
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat Example', role } });
}

function renderAt(path) {
  return render(<TestProviders initialEntries={[path]}><AppRoutes /></TestProviders>);
}

function navLinks() {
  const nav = screen.getByRole('navigation', { name: 'Main navigation' });
  return within(nav).getAllByRole('link').map((link) => link.textContent);
}

beforeEach(() => {
  clearSession();
  request.mockReset();
  request.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
});

describe('routing and layout', () => {
  it('sends signed-out users to the sign-in page', () => {
    renderAt('/projects');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the app bar, the user, their role and the landmarks', () => {
    signInAs('manager');
    renderAt('/');
    expect(screen.getByRole('banner')).toHaveTextContent('ACME Project Tracker');
    expect(screen.getByText('Pat Example')).toBeInTheDocument();
    expect(screen.getByLabelText('Role: Manager')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
  });

  it('moves focus to the main content from the skip link', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('link', { name: 'Skip to main content' }));
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('hides navigation the role cannot use', () => {
    signInAs('manager');
    renderAt('/');
    expect(navLinks()).toEqual(['Dashboard', 'Projects', 'Resources']);
  });

  it('shows admins the Users page and marks the current item', () => {
    signInAs('admin');
    renderAt('/users');
    expect(navLinks()).toEqual(['Dashboard', 'Projects', 'Resources', 'Users']);
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
  });

  it('shows a not-allowed page when a non-admin opens /users', () => {
    signInAs('contributor');
    renderAt('/users');
    expect(screen.getByRole('heading', { name: 'You do not have access to this page' })).toBeInTheDocument();
    expect(screen.getByText(/Your role \(Contributor\) cannot open it/)).toBeInTheDocument();
  });

  it('shows a not-found page for unknown routes', () => {
    signInAs('viewer');
    renderAt('/no-such-page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });

  it('routes to the projects page and the project placeholder', () => {
    signInAs('viewer');
    renderAt('/projects/4');
    expect(screen.getByRole('heading', { level: 1, name: 'Project details' })).toBeInTheDocument();
  });

  it('opens the navigation from the menu button on phones', async () => {
    window.innerWidth = 375;
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/');

    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    await user.click(await screen.findByRole('link', { name: 'Projects' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
  });

  it('signs out', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });
});
