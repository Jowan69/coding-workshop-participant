import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';
import TestProviders, { LocationProbe } from './TestProviders';
import { ApiError, request } from './services/apiClient';
import { clearSession, getSession, setSession } from './services/session';
import { PASSWORD_RULES } from './utils/passwordRules';

vi.mock('./services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const USER = { id: 1, full_name: 'Pat Example', role: 'viewer', must_change_password: false };
const FRESH = {
  access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 1800, user: USER,
};

function signIn(user = USER) {
  setSession({ accessToken: 't', refreshToken: 'r', user });
}

function renderAt(path) {
  return render(
    <TestProviders initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </TestProviders>,
  );
}

function callsTo(path) {
  return request.mock.calls.filter(([url]) => url === path);
}

/** Answer every GET with an empty list and the given POST paths with a handler. */
function useApi(posts = {}) {
  request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
    if (method === 'POST' && posts[path]) return posts[path](body);
    return { items: [], total: 0, limit: 10, offset: 0 };
  });
}

beforeEach(() => {
  clearSession();
  request.mockReset();
  useApi();
});

describe('sign out', () => {
  it('calls /auth/logout, then clears the session and shows the sign-in page', async () => {
    signIn();
    useApi({ '/auth/logout': () => null });
    const user = userEvent.setup();
    renderAt('/projects');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(callsTo('/auth/logout')).toEqual([['/auth/logout', { method: 'POST' }]]);
    expect(getSession()).toBeNull();
  });

  it('clears the session even when /auth/logout fails', async () => {
    signIn();
    useApi({
      '/auth/logout': () => {
        throw new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server.' });
      },
    });
    const user = userEvent.setup();
    renderAt('/projects');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(callsTo('/auth/logout')).toHaveLength(1);
    expect(getSession()).toBeNull();
  });
});

describe('change password from the account menu', () => {
  async function openDialog(user) {
    await user.click(screen.getByRole('button', { name: 'Account menu for Pat Example' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change password' }));
    return screen.findByRole('dialog', { name: 'Change password' });
  }

  it.each([[1024, 'desktop'], [375, 'phone']])('offers the menu at %ipx (%s)', async (width) => {
    window.innerWidth = width;
    signIn();
    const user = userEvent.setup();
    renderAt('/projects');
    const menuButton = screen.getByRole('button', { name: 'Account menu for Pat Example' });
    expect(menuButton).toHaveAttribute('aria-haspopup', 'menu');
    const dialog = await openDialog(user);
    expect(within(dialog).getByText(PASSWORD_RULES)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Current password/)).toHaveAttribute('autocomplete', 'current-password');
    expect(within(dialog).getByLabelText(/^New password/)).toHaveAttribute('autocomplete', 'new-password');
  });

  it('changes the password and keeps the user signed in with the fresh tokens', async () => {
    signIn();
    useApi({ '/auth/change-password': () => FRESH });
    const user = userEvent.setup();
    renderAt('/projects');
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(/^Current password/), 'Old-Pass-123');
    await user.type(within(dialog).getByLabelText(/^New password/), 'Tangerine-Sky-42');
    await user.type(within(dialog).getByLabelText(/^Repeat new password/), 'Tangerine-Sky-42');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(callsTo('/auth/change-password')).toEqual([['/auth/change-password', {
      method: 'POST', body: { current_password: 'Old-Pass-123', new_password: 'Tangerine-Sky-42' },
    }]]));
    expect(await screen.findByText('Password changed. Other devices were signed out.')).toBeInTheDocument();
    expect(getSession()).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
  });

  it('checks the rules before asking the API', async () => {
    signIn();
    const user = userEvent.setup();
    renderAt('/projects');
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(/^Current password/), 'Old-Pass-123');
    await user.type(within(dialog).getByLabelText(/^New password/), 'short1');
    await user.type(within(dialog).getByLabelText(/^Repeat new password/), 'different');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(within(dialog).getByText('New password must be at least 10 characters')).toBeInTheDocument();
    expect(within(dialog).getByText('The two new passwords do not match')).toBeInTheDocument();
    expect(callsTo('/auth/change-password')).toHaveLength(0);
  });

  it('shows a wrong current password and a refused new password next to their fields', async () => {
    signIn();
    useApi({
      '/auth/change-password': () => {
        throw new ApiError({
          status: 400,
          code: 'validation_error',
          message: 'Validation failed',
          fieldErrors: { current_password: 'is incorrect', new_password: 'is too common; choose one that is harder to guess' },
        });
      },
    });
    const user = userEvent.setup();
    renderAt('/projects');
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(/^Current password/), 'Wrong-Pass-123');
    await user.type(within(dialog).getByLabelText(/^New password/), 'welcome12345');
    await user.type(within(dialog).getByLabelText(/^Repeat new password/), 'welcome12345');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    expect(await within(dialog).findByText('Current password is incorrect')).toBeInTheDocument();
    expect(within(dialog).getByText('New password is too common; choose one that is harder to guess')).toBeInTheDocument();
    expect(getSession()).toMatchObject({ accessToken: 't' });
  });
});

describe('a temporary password blocks the app', () => {
  const TEMPORARY = { ...USER, must_change_password: true };

  it.each(['/', '/projects', '/projects/3', '/resources', '/users'])('sends %s to the change-password screen', async (path) => {
    signIn(TEMPORARY);
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/change-password');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByText(PASSWORD_RULES)).toBeInTheDocument();
  });

  it('lets the user in once they choose a new password', async () => {
    signIn(TEMPORARY);
    useApi({ '/auth/change-password': () => FRESH });
    const user = userEvent.setup();
    renderAt('/projects');

    await user.type(await screen.findByLabelText(/^Temporary password/), 'Temp-Pass-123');
    await user.type(screen.getByLabelText(/^New password/), 'Tangerine-Sky-42');
    await user.type(screen.getByLabelText(/^Repeat new password/), 'Tangerine-Sky-42');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(callsTo('/auth/change-password')[0][1].body).toEqual({
      current_password: 'Temp-Pass-123', new_password: 'Tangerine-Sky-42',
    });
    expect(getSession().user.must_change_password).toBe(false);
  });

  it('validates the form and shows the API\'s field errors', async () => {
    signIn(TEMPORARY);
    useApi({
      '/auth/change-password': () => {
        throw new ApiError({
          status: 400, code: 'validation_error', message: 'Validation failed',
          fieldErrors: { current_password: 'is incorrect' },
        });
      },
    });
    const user = userEvent.setup();
    renderAt('/change-password');

    await user.click(await screen.findByRole('button', { name: 'Change password' }));
    expect(screen.getByText('Temporary password is required')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Temporary password/)).toHaveFocus();
    expect(callsTo('/auth/change-password')).toHaveLength(0);

    await user.type(screen.getByLabelText(/^Temporary password/), 'Wrong-Temp-123');
    await user.type(screen.getByLabelText(/^New password/), 'Tangerine-Sky-42');
    await user.type(screen.getByLabelText(/^Repeat new password/), 'Tangerine-Sky-42');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Temporary password is incorrect')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeInTheDocument();
  });

  it('lets the user sign out instead', async () => {
    signIn(TEMPORARY);
    useApi({ '/auth/logout': () => null });
    const user = userEvent.setup();
    renderAt('/change-password');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(getSession()).toBeNull();
  });

  it('is not shown to a user whose password is their own', async () => {
    signIn();
    renderAt('/change-password');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign in', async () => {
    renderAt('/change-password');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
