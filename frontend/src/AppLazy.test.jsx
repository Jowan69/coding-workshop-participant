import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import TestProviders from './TestProviders';
import { request } from './services/apiClient';
import { clearSession, setSession } from './services/session';

vi.mock('./services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

/**
 * Phase 6, G2: route pages are separate chunks (React.lazy). Each test here opens a page that
 * no earlier test in this file has loaded, so its loading state is really shown first.
 */
beforeEach(() => {
  clearSession();
  request.mockReset();
  request.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
});

function renderAt(path) {
  return render(<TestProviders initialEntries={[path]}><AppRoutes /></TestProviders>);
}

describe('lazy-loaded pages', () => {
  it('keeps the shell on screen with a loading state while a page\'s code is fetched', async () => {
    setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat Example', role: 'viewer' } });
    renderAt('/resources');

    expect(screen.getByRole('banner')).toHaveTextContent('ACME Project Tracker');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('progressbar', { name: 'Loading page' })).toBeInTheDocument();
    expect(within(main).getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { level: 1, name: 'Resources' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Loading page' })).not.toBeInTheDocument();
  });

  it('shows a full-screen loading state before a page that has no shell', async () => {
    renderAt('/projects');

    expect(screen.getByRole('progressbar', { name: 'Loading page' })).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Loading page' })).not.toBeInTheDocument();
  });

  it('loads every page as its own chunk', async () => {
    const source = (await import('./App.jsx?raw')).default;
    const lazyPages = [...source.matchAll(/const (\w+) = lazy\(\(\) => import\('\.\/pages\/(\w+)'\)\);/g)]
      .map((match) => match[2]);
    expect(lazyPages.sort()).toEqual([
      'ChangePasswordPage', 'DashboardPage', 'LoginPage', 'NotFoundPage', 'ProjectDetailPage',
      'ProjectsPage', 'ResourcesPage', 'UsersPage',
    ]);
    expect(source).not.toMatch(/^import \w+ from '\.\/pages\//m);
  });
});
