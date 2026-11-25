import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../App';
import TestProviders from '../TestProviders';
import { ApiError, request } from '../services/apiClient';
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
    // Phase 6 (F7): choosing a role asks first; nothing is sent until it is confirmed
    const confirm = await screen.findByRole('dialog', { name: 'Make Tom Becker Manager?' });
    expect(request.mock.calls.filter(([, options = {}]) => options.method === 'PUT')).toHaveLength(0);
    await user.click(within(confirm).getByRole('button', { name: 'Make Manager' }));

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
    expect(within(dialog).getByText('Temporary password must be at least 10 characters')).toBeInTheDocument();

    await user.type(password, ' enough 1 ');
    await user.click(within(dialog).getByRole('combobox', { name: /^Role/ }));
    await user.click(await screen.findByRole('option', { name: 'Contributor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/auth/users', {
      method: 'POST',
      body: {
        full_name: 'Dana Lee', email: 'dana@acme.test', password: 'short enough 1 ', role: 'contributor',
      },
      idempotencyKey: expect.any(String), // phase 6 (D2)
    }));
    expect(await screen.findByText('Dana Lee can now sign in')).toBeInTheDocument();
  });
});

describe('UsersPage search and filters', () => {
  const lastListQuery = () => request.mock.calls
    .filter(([path, options = {}]) => path === '/auth/users' && (options.method ?? 'GET') === 'GET')
    .at(-1)[1].query;

  it('offers a search box and role and status filters', async () => {
    signInAs(ME);
    renderAt();
    await screen.findByRole('table', { name: 'Users' });
    const bar = screen.getByRole('search', { name: 'Filter users' });
    expect(within(bar).getByRole('searchbox', { name: 'Search by name or email' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });

  it('sends q, role and is_active from the URL to the API', async () => {
    signInAs(ME);
    renderAt('/users?q=tom&role=viewer&is_active=true');
    await screen.findByRole('table', { name: 'Users' });
    expect(lastListQuery()).toEqual({ q: 'tom', role: 'viewer', is_active: 'true', limit: 10, offset: 0 });
    expect(screen.getByRole('searchbox', { name: 'Search by name or email' })).toHaveValue('tom');
  });

  it('filters by role and by status when chosen', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('table', { name: 'Users' });

    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Manager' }));
    await waitFor(() => expect(lastListQuery()).toMatchObject({ role: 'manager' }));

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Inactive' }));
    await waitFor(() => expect(lastListQuery()).toMatchObject({ role: 'manager', is_active: 'false' }));
  });

  it('searches as the admin types', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('table', { name: 'Users' });
    await user.type(screen.getByRole('searchbox', { name: 'Search by name or email' }), 'olga');
    await waitFor(() => expect(lastListQuery()).toMatchObject({ q: 'olga' }));
  });

  it('offers to clear the filters when nobody matches', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    request.mockImplementation(async (path, { query = {} } = {}) => (
      query.q ? { items: [], total: 0, limit: 10, offset: 0 }
        : { items: USERS, total: USERS.length, limit: 10, offset: 0 }
    ));
    renderAt('/users?q=nobody');
    expect(await screen.findByText('No users match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByRole('table', { name: 'Users' })).toBeInTheDocument();
  });
});

describe('UsersPage accounts: reset password, delete and unlock (phase 6, part B)', () => {
  const LOCKED = { id: 6, email: 'locked@acme.test', full_name: 'Lena Locked', role: 'viewer', is_active: true, is_locked: true };
  const TEMPORARY = { id: 7, email: 'temp@acme.test', full_name: 'Tess Temp', role: 'viewer', is_active: true, must_change_password: true };
  const calls = (method, path) => request.mock.calls
    .filter(([url, options = {}]) => url === path && (options.method ?? 'GET') === method);

  function useUsers(users, handlers = {}) {
    request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
      const handler = handlers[`${method} ${path}`];
      if (handler) return handler(body);
      if (method === 'GET') return { items: users, total: users.length, limit: 10, offset: 0 };
      if (method === 'DELETE') return null;
      return { id: 9, ...body };
    });
  }

  it('no longer promises that changes take 30 minutes', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.getByText(/signs that person out at once/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Deactivate Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Tom Becker?' });
    expect(dialog).toHaveTextContent('They are signed out at once');
    expect(document.body).not.toHaveTextContent(/30 minutes/);
  });

  it('resets a password to a temporary one, with the rules under the field', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Reset password of Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset password of Tom Becker' });
    const field = within(dialog).getByLabelText(/^Temporary password/);
    expect(field).toHaveAttribute('type', 'password');
    expect(within(dialog).getByText(/^10 to 128 characters, with at least one letter and one digit/)).toBeInTheDocument();

    await user.type(field, 'nodigitshere');
    await user.click(within(dialog).getByRole('button', { name: 'Set temporary password' }));
    expect(within(dialog).getByText('Temporary password must contain at least one digit')).toBeInTheDocument();
    expect(calls('PUT', '/auth/users/4')).toHaveLength(0);

    await user.clear(field);
    await user.type(field, 'Tangerine-Sky-42');
    await user.click(within(dialog).getByRole('button', { name: 'Set temporary password' }));
    await waitFor(() => expect(calls('PUT', '/auth/users/4')).toEqual([
      ['/auth/users/4', { method: 'PUT', body: { password: 'Tangerine-Sky-42' } }],
    ]));
    expect(await screen.findByText('Tom Becker must choose a new password at their next sign-in')).toBeInTheDocument();
  });

  it('shows the rule the API says a temporary password broke', async () => {
    signInAs(ME);
    useUsers(USERS, {
      'PUT /auth/users/4': () => {
        throw new ApiError({
          status: 400, code: 'validation_error', message: 'Validation failed',
          fieldErrors: { password: "must not contain the person's name" },
        });
      },
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Reset password of Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset password of Tom Becker' });
    await user.type(within(dialog).getByLabelText(/^Temporary password/), 'tombecker-2026');
    await user.click(within(dialog).getByRole('button', { name: 'Set temporary password' }));
    expect(await within(dialog).findByText("Temporary password must not contain the person's name")).toBeInTheDocument();
  });

  it('deletes a user after confirmation', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Delete Olga Old' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Olga Old?' });
    expect(calls('DELETE', '/auth/users/5')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    await waitFor(() => expect(calls('DELETE', '/auth/users/5')).toHaveLength(1));
    expect(await screen.findByText('Olga Old was deleted')).toBeInTheDocument();
  });

  it("shows the API's reason when a user who owns records cannot be deleted", async () => {
    signInAs(ME);
    const reason = 'User 4 owns 2 project(s) and recorded 3 budget entry(ies); deactivate the account instead';
    useUsers(USERS, {
      'DELETE /auth/users/4': () => {
        throw new ApiError({ status: 409, code: 'user_in_use', message: reason });
      },
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Delete Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Tom Becker?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete Tom Becker?' })).toBeInTheDocument();
  });

  it('offers neither reset nor delete on the admin\'s own row', async () => {
    signInAs(ME);
    renderAt();
    await screen.findByRole('table', { name: 'Users' });
    expect(screen.queryByRole('button', { name: 'Reset password of Priya Shah' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Priya Shah' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset password of Tom Becker' })).toBeEnabled();
  });

  it('marks a locked account and unlocks it', async () => {
    signInAs(ME);
    useUsers([ME, LOCKED, TEMPORARY]);
    const user = userEvent.setup();
    renderAt();
    const table = await screen.findByRole('table', { name: 'Users' });
    const row = within(table).getByRole('row', { name: /Lena Locked/ });
    expect(within(row).getByText('Locked')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /Tess Temp/ })).getByText('Temporary password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock Tess Temp' })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Unlock Lena Locked' }));
    await waitFor(() => expect(calls('DELETE', '/auth/users/6/lockout')).toHaveLength(1));
    expect(await screen.findByText('Lena Locked can try to sign in again')).toBeInTheDocument();
  });

  it('says why an unlock failed', async () => {
    signInAs(ME);
    useUsers([ME, LOCKED], {
      'DELETE /auth/users/6/lockout': () => {
        throw new ApiError({ status: 404, code: 'not_found', message: 'User 6 not found' });
      },
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Unlock Lena Locked' }));
    expect(await screen.findByText('User 6 not found')).toBeInTheDocument();
  });
});

describe('UsersPage lost updates (phase 6, D3)', () => {
  const STAMP = '2026-11-24T09:00:00.000000+00:00';
  const STAMPED = USERS.map((account) => ({ ...account, updated_at: STAMP }));
  const puts = (path) => request.mock.calls.filter(([url, options = {}]) => url === path && options.method === 'PUT');

  function useUsers(handlers = {}) {
    request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
      const handler = handlers[`${method} ${path}`];
      if (handler) return handler(body);
      if (method === 'GET') return { items: STAMPED, total: STAMPED.length, limit: 10, offset: 0 };
      return { id: 9, ...body };
    });
  }

  it('sends expected_updated_at when reactivating and when resetting a password', async () => {
    signInAs(ME);
    useUsers();
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Reactivate Olga Old' }));
    await waitFor(() => expect(puts('/auth/users/5')).toHaveLength(1));
    expect(puts('/auth/users/5')[0][1].body).toEqual({ is_active: true, expected_updated_at: STAMP });

    await user.click(screen.getByRole('button', { name: 'Reset password of Tom Becker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset password of Tom Becker' });
    await user.type(within(dialog).getByLabelText(/^Temporary password/), 'Tangerine-Sky-42');
    await user.click(within(dialog).getByRole('button', { name: 'Set temporary password' }));
    await waitFor(() => expect(puts('/auth/users/4')).toHaveLength(1));
    expect(puts('/auth/users/4')[0][1].body).toEqual({ password: 'Tangerine-Sky-42', expected_updated_at: STAMP });
  });

  it('offers to reload when another admin changed the account first', async () => {
    signInAs(ME);
    useUsers({
      'PUT /auth/users/5': () => {
        throw new ApiError({ status: 409, code: 'stale_record', message: 'This user was changed by someone else.' });
      },
    });
    const user = userEvent.setup();
    renderAt();
    await user.click(await screen.findByRole('button', { name: 'Reactivate Olga Old' }));
    const message = await screen.findByText('This was changed by someone else');
    const loads = request.mock.calls.filter(([url, options = {}]) => url === '/auth/users' && !options.method).length;
    await user.click(within(message.closest('[role="status"]')).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(
      request.mock.calls.filter(([url, options = {}]) => url === '/auth/users' && !options.method).length,
    ).toBeGreaterThan(loads));
  });
});

describe('UsersPage role change confirmation (phase 6, F7)', () => {
  const puts = () => request.mock.calls.filter(([, options = {}]) => options.method === 'PUT');

  async function chooseRole(user, name, role) {
    await user.click(await screen.findByRole('combobox', { name: `Role of ${name}` }));
    await user.click(await screen.findByRole('option', { name: role }));
  }

  it('names the person, the old and the new role, and says they will be signed out', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await chooseRole(user, 'Tom Becker', 'Contributor');
    const dialog = await screen.findByRole('dialog', { name: 'Make Tom Becker Contributor?' });
    expect(dialog).toHaveTextContent('Tom Becker changes from Viewer to Contributor and is signed out');
    expect(dialog).toHaveTextContent('A contributor can create and edit projects');
    expect(within(dialog).getByRole('button', { name: 'Make Contributor' })).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it('spells out what an admin can do before granting Admin', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await chooseRole(user, 'Tom Becker', 'Admin');
    const dialog = await screen.findByRole('dialog', { name: 'Make Tom Becker Admin?' });
    expect(dialog).toHaveTextContent('An admin can create, edit and delete every record');
    expect(dialog).toHaveTextContent("change anyone's role, reset passwords");
    await user.click(within(dialog).getByRole('button', { name: 'Make Admin' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual(['/auth/users/4', { method: 'PUT', body: { role: 'admin' } }]);
    expect(await screen.findByText('Tom Becker is now Admin')).toBeInTheDocument();
  });

  it('changes nothing when the admin cancels', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await chooseRole(user, 'Tom Becker', 'Manager');
    const dialog = await screen.findByRole('dialog', { name: 'Make Tom Becker Manager?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(puts()).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Role of Tom Becker' })).toHaveTextContent('Viewer');
  });

  it('asks nothing when the same role is chosen again', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    await chooseRole(user, 'Tom Becker', 'Viewer');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});

describe('UsersPage sorting (phase 6, F3)', () => {
  it('sorts by a clicked column through the API', async () => {
    signInAs(ME);
    const user = userEvent.setup();
    renderAt();
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(within(table).getByRole('columnheader', { name: 'Email' })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(within(within(table).getByRole('columnheader', { name: 'Role' })).getByRole('button'));
    await waitFor(() => expect(
      request.mock.calls.filter(([path, options = {}]) => path === '/auth/users' && !options.method).at(-1)[1].query,
    ).toEqual({ sort: 'role', limit: 10, offset: 0 }));
    expect(within(screen.getByRole('table', { name: 'Users' })).getByRole('columnheader', { name: 'Role' }))
      .toHaveAttribute('aria-sort', 'ascending');
  });
});
