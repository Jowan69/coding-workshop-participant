import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import TestProviders from '../TestProviders';
import { request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const ME = { id: 1, email: 'admin@acme.test', full_name: 'Priya Shah', role: 'admin', is_active: true };
const USERS = [
  ME,
  { id: 4, email: 'viewer@acme.test', full_name: 'Tom Becker', role: 'viewer', is_active: true },
  { id: 5, email: 'old@acme.test', full_name: 'Olga Old', role: 'contributor', is_active: false },
];
const OWN_ROLE_REASON = 'You cannot change your own role. Ask another admin.';
const OWN_ACCOUNT_REASON = 'You cannot deactivate your own account. Ask another admin.';

function signInAs(user) {
  setSession({ accessToken: 't', refreshToken: 'r', user });
}

function renderAt(path = '/users') {
  return render(<TestProviders initialEntries={[path]}><AppRoutes /></TestProviders>);
}

function userRequests() {
  return request.mock.calls.filter(([path]) => path.startsWith('/auth/users'));
}

beforeEach(() => {
  clearSession();
  request.mockReset();
  request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
    if (method === 'GET') return { items: USERS, total: USERS.length, limit: 10, offset: 0 };
    return { id: 9, ...body };
  });
});

describe('UsersPage access', () => {
  it.each(['viewer', 'contributor', 'manager'])('is blocked for a %s', async (role) => {
    signInAs({ id: 7, full_name: 'Pat', role });
    renderAt();

    expect(screen.getByRole('heading', { name: 'You do not have access to this page' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    await waitFor(() => expect(userRequests()).toHaveLength(0));
  });

  it('opens for an admin', async () => {
    signInAs(ME);
    renderAt();
    expect(await screen.findByRole('table', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
  });
});

describe('UsersPage self-protection', () => {
  it("disables the admin's own role and deactivate controls and says why", async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('table', { name: 'Users' });

    const ownRole = screen.getByRole('combobox', { name: 'Role of Priya Shah' });
    expect(ownRole).toHaveAttribute('aria-disabled', 'true');
    const ownDeactivate = screen.getByRole('button', { name: 'Deactivate Priya Shah' });
    expect(ownDeactivate).toBeDisabled();

    const roleReason = screen.getByLabelText(OWN_ROLE_REASON);
    expect(roleReason).toContainElement(ownRole);
    await user.hover(roleReason);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(OWN_ROLE_REASON);
    await user.unhover(roleReason);

    const accountReason = screen.getByLabelText(OWN_ACCOUNT_REASON);
    expect(accountReason).toContainElement(ownDeactivate);
    accountReason.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(OWN_ACCOUNT_REASON));

    await user.click(ownRole);
    expect(screen.queryByRole('option', { name: 'Viewer' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([, options = {}]) => options.method === 'PUT')).toHaveLength(0);
  });

  it("leaves other people's controls enabled", async () => {
    signInAs(ME);
    renderAt();
    await screen.findByRole('table', { name: 'Users' });

    expect(screen.getByRole('combobox', { name: 'Role of Tom Becker' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('button', { name: 'Deactivate Tom Becker' })).toBeEnabled();
    expect(screen.getByLabelText(OWN_ROLE_REASON))
      .not.toContainElement(screen.getByRole('combobox', { name: 'Role of Tom Becker' }));
    expect(screen.getAllByText('You')).toHaveLength(1);
  });
});

describe('UsersPage actions', () => {
  it('changes a role', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByRole('combobox', { name: 'Role of Tom Becker' }));
    await user.click(await screen.findByRole('option', { name: 'Manager' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/auth/users/4', {
      method: 'PUT', body: { role: 'manager' },
    }));
    expect(await screen.findByText('Tom Becker is now Manager')).toBeInTheDocument();
  });

  it('deactivates after confirmation and reactivates directly', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();

    await user.click(await screen.findByRole('button', { name: 'Deactivate Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Tom Becker?' });
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(request).toHaveBeenCalledWith('/auth/users/4', { method: 'PUT', body: { is_active: false } });
    expect(await screen.findByText('Tom Becker was deactivated')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Reactivate Olga Old' }));
    expect(request).toHaveBeenCalledWith('/auth/users/5', { method: 'PUT', body: { is_active: true } });
    expect(await screen.findByText('Olga Old can sign in again')).toBeInTheDocument();
  });

  it('creates a user with a role and a hidden, validated password', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('table', { name: 'Users' });

    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = await screen.findByRole('dialog', { name: 'New user' });
    const password = within(dialog).getByLabelText(/^Temporary password/);
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');

    await user.type(within(dialog).getByRole('textbox', { name: /^Full name/ }), 'Dana Lee');
    await user.type(within(dialog).getByRole('textbox', { name: /^Email/ }), 'dana@acme.test');
    await user.type(password, 'short');
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(within(dialog).getByText('Temporary password must be at least 8 characters')).toBeInTheDocument();

    await user.type(password, ' enough ');
    await user.click(within(dialog).getByRole('combobox', { name: /^Role/ }));
    await user.click(await screen.findByRole('option', { name: 'Contributor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/auth/users', {
      method: 'POST',
      body: {
        full_name: 'Dana Lee', email: 'dana@acme.test', password: 'short enough ', role: 'contributor',
      },
    }));
    expect(await screen.findByText('Dana Lee can now sign in')).toBeInTheDocument();
  });
});
