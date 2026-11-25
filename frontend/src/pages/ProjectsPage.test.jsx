import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { ApiError, request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';
import ProjectsPage from './ProjectsPage';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const PROJECTS = [
  {
    id: 1,
    name: 'Customer Portal Revamp',
    department: 'Digital',
    status: 'active',
    start_date: '2026-01-01',
    end_date: '2099-12-31',
    budget_planned: 200000,
    budget_spent: 50000,
    percent_complete: 60,
  },
  {
    id: 2,
    name: 'Data Center Migration',
    department: 'Infrastructure',
    status: 'active',
    start_date: '2025-01-01',
    end_date: '2025-06-30',
    budget_planned: 100000,
    budget_spent: 120000,
    percent_complete: 40,
    is_overdue: true, // phase 6 (E4): the API decides, not the browser's date
    as_of: '2026-11-24',
  },
];

function listCalls() {
  return request.mock.calls.filter(([path, options = {}]) => (
    path === '/projects' && (options.method ?? 'GET') === 'GET' && options.query?.limit !== 100
  ));
}

function signInAs(role) {
  setSession({ accessToken: 'token', refreshToken: 'refresh', user: { id: 1, full_name: 'Pat', role } });
}

function renderPage(entry = '/projects') {
  return render(
    <TestProviders initialEntries={[entry]}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </TestProviders>,
  );
}

beforeEach(() => {
  clearSession();
  request.mockReset();
  request.mockImplementation(async (path, { method = 'GET' } = {}) => {
    if (method === 'GET') return { items: PROJECTS, total: PROJECTS.length, limit: 10, offset: 0 };
    if (method === 'DELETE') return null;
    return { id: 3 };
  });
});

describe('ProjectsPage role matrix', () => {
  it.each([
    ['viewer', { create: false, edit: false, remove: false }],
    ['contributor', { create: true, edit: true, remove: false }],
    ['manager', { create: true, edit: true, remove: true }],
    ['admin', { create: true, edit: true, remove: true }],
  ])('%s sees only the controls their role allows', async (role, expected) => {
    signInAs(role);
    renderPage();
    await screen.findByRole('link', { name: 'Customer Portal Revamp' });

    const presence = (element) => element !== null;
    expect(presence(screen.queryByRole('button', { name: 'New project' }))).toBe(expected.create);
    expect(presence(screen.queryByRole('button', { name: 'Edit Customer Portal Revamp' }))).toBe(expected.edit);
    expect(presence(screen.queryByRole('button', { name: 'Delete Customer Portal Revamp' }))).toBe(expected.remove);
    const hasActionsColumn = screen.queryByRole('columnheader', { name: 'Actions' }) !== null;
    expect(hasActionsColumn).toBe(expected.edit || expected.remove);
  });
});

describe('ProjectsPage', () => {
  it('shows each project with status, deadline risk, progress and budget used', async () => {
    signInAs('viewer');
    renderPage();
    const table = await screen.findByRole('table', { name: 'Projects' });

    const rows = within(table).getAllByRole('row');
    const migration = rows.find((row) => within(row).queryByText('Data Center Migration'));
    expect(within(migration).getByText('Infrastructure')).toBeInTheDocument();
    expect(within(migration).getByText('Active')).toBeInTheDocument();
    expect(within(migration).getByText('Overdue')).toBeInTheDocument();
    expect(within(migration).getByRole('progressbar', { name: 'Data Center Migration percent complete' }))
      .toHaveAttribute('aria-valuenow', '40');
    expect(within(migration).getByText('$120,000 of $100,000 (120%)')).toBeInTheDocument();

    const portal = rows.find((row) => within(row).queryByText('Customer Portal Revamp'));
    expect(within(portal).queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('opens a project when its row is clicked', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Infrastructure'));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/2');
  });

  it('reads filters from the URL and sends them to the API', async () => {
    signInAs('viewer');
    renderPage('/projects?status=on_hold&q=bank');

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().at(-1)[1].query).toEqual({ status: 'on_hold', q: 'bank', limit: 10, offset: 0 });
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('bank');
  });

  it('filters by status and clears the filters', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Completed' }));
    await waitFor(() => expect(listCalls().at(-1)[1].query.status).toBe('completed'));

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(listCalls().at(-1)[1].query.status).toBeUndefined());
  });

  it('offers a way out when no project matches the filters', async () => {
    signInAs('viewer');
    request.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
    renderPage('/projects?q=nothing');

    expect(await screen.findByRole('heading', { name: 'No projects match these filters' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });

  it('shows a load failure with a retry', async () => {
    signInAs('viewer');
    request.mockRejectedValueOnce(new Error('Cannot reach the server.'));
    const user = userEvent.setup();
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot reach the server.');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Customer Portal Revamp' })).toBeInTheDocument();
  });

  it('creates a project', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    const callsBefore = listCalls().length;

    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Warehouse Robotics');
    await user.type(within(dialog).getByRole('combobox', { name: /^Department/ }), 'Operations');
    fireEvent.change(within(dialog).getByLabelText(/^Start date/), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(/^Deadline/), { target: { value: '2026-06-30' } });
    await user.clear(within(dialog).getByRole('spinbutton', { name: /^Planned budget/ }));
    await user.type(within(dialog).getByRole('spinbutton', { name: /^Planned budget/ }), '125000');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/projects', {
      method: 'POST',
      body: {
        name: 'Warehouse Robotics',
        department: 'Operations',
        status: 'planned',
        start_date: '2026-01-01',
        end_date: '2026-06-30',
        budget_planned: 125000,
        owner_id: 1, // phase 6 (D4): defaults to the signed-in user
      },
      idempotencyKey: expect.any(String), // phase 6 (D2)
    }));
    expect(await screen.findByText('Project created')).toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(callsBefore));
  });

  it('edits a project', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit Customer Portal Revamp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Customer Portal Revamp' });
    const name = within(dialog).getByRole('textbox', { name: /^Name/ });
    expect(name).toHaveValue('Customer Portal Revamp');
    await user.type(name, ' 2');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/projects/1', expect.objectContaining({
      method: 'PUT',
      body: { name: 'Customer Portal Revamp 2' }, // phase 6 (D3): only what changed
    })));
    expect(await screen.findByText('Project updated')).toBeInTheDocument();
  });

  it('deletes a project after confirmation', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete Data Center Migration' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete project?' });
    expect(dialog).toHaveTextContent('"Data Center Migration" and all of its deliverables');
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    expect(request).toHaveBeenCalledWith('/projects/2', { method: 'DELETE' });
    expect(await screen.findByText('Project deleted')).toBeInTheDocument();
  });

  it('keeps the confirmation open when the delete fails', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    request.mockRejectedValueOnce(new Error('You do not have permission to do that.'));

    await user.click(screen.getByRole('button', { name: 'Delete Data Center Migration' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete project?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    expect(await screen.findByText('You do not have permission to do that.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete project?' })).toBeInTheDocument();
  });
});

describe('ProjectsPage write integrity (phase 6, part D)', () => {
  const STAMPED = PROJECTS.map((project, index) => ({
    ...project, owner_id: 3, owner_name: 'Maria Gonzalez', updated_at: `2026-11-24T10:0${index}:00.000000+00:00`,
  }));
  const OPTIONS = [
    { id: 2, full_name: 'Daniel Okafor' }, { id: 3, full_name: 'Maria Gonzalez' }, { id: 1, full_name: 'Pat' },
  ];
  const calls = (method, path) => request.mock.calls
    .filter(([url, options = {}]) => url === path && (options.method ?? 'GET') === method);

  function useApi(handlers = {}) {
    request.mockImplementation(async (path, { method = 'GET', body, query } = {}) => {
      const handler = handlers[`${method} ${path}`];
      if (handler) return handler({ body, query });
      if (path === '/auth/users/options') return { items: OPTIONS, total: 3, limit: 3, offset: 0 };
      if (method === 'GET') return { items: STAMPED, total: STAMPED.length, limit: 10, offset: 0 };
      if (method === 'DELETE') return null;
      return { id: 3, ...body };
    });
  }

  async function fillNewProject(user, dialog) {
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Warehouse Robotics');
    await user.type(within(dialog).getByRole('combobox', { name: /^Department/ }), 'Operations');
    fireEvent.change(within(dialog).getByLabelText(/^Start date/), { target: { value: '2026-01-01' } });
    fireEvent.change(within(dialog).getByLabelText(/^Deadline/), { target: { value: '2026-06-30' } });
  }

  it('defaults the owner to the signed-in user and lets it be changed', async () => {
    signInAs('contributor');
    useApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    const owner = within(dialog).getByRole('combobox', { name: 'Owner' });
    expect(owner).toHaveValue('Pat');
    expect(owner).not.toBeRequired();

    await fillNewProject(user, dialog);
    await user.click(owner);
    await user.click(await screen.findByRole('option', { name: 'Daniel Okafor' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(calls('POST', '/projects')).toHaveLength(1));
    expect(calls('POST', '/projects')[0][1].body).toMatchObject({ name: 'Warehouse Robotics', owner_id: 2 });
    expect(calls('GET', '/auth/users/options')).toHaveLength(1);
  });

  it('sends null when the owner is cleared, so the project has no owner', async () => {
    signInAs('contributor');
    useApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await fillNewProject(user, dialog);
    await user.clear(within(dialog).getByRole('combobox', { name: 'Owner' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(calls('POST', '/projects')).toHaveLength(1));
    expect(calls('POST', '/projects')[0][1].body.owner_id).toBeNull();
  });

  it('keeps the current owner selectable when editing, even if they are not in the options', async () => {
    signInAs('contributor');
    useApi({ 'GET /auth/users/options': () => ({ items: [OPTIONS[0]], total: 1, limit: 1, offset: 0 }) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit Customer Portal Revamp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Customer Portal Revamp' });
    expect(within(dialog).getByRole('combobox', { name: 'Owner' })).toHaveValue('Maria Gonzalez');
  });

  it('does not ask for the user options when the role cannot edit projects', async () => {
    signInAs('viewer');
    useApi();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    expect(calls('GET', '/auth/users/options')).toHaveLength(0);
  });

  it('retries a failed create with the same idempotency key', async () => {
    signInAs('contributor');
    let attempts = 0;
    useApi({
      'POST /projects': ({ body }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server.' });
        }
        return { id: 3, ...body };
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await fillNewProject(user, dialog);

    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Create project' })).toBeEnabled());
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Project created')).toBeInTheDocument();

    const keys = calls('POST', '/projects').map(([, options]) => options.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('sends one request when Create is clicked twice quickly', async () => {
    signInAs('contributor');
    useApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await fillNewProject(user, dialog);
    const create = within(dialog).getByRole('button', { name: 'Create project' });
    act(() => {
      create.click();
      create.click();
    });
    expect(await screen.findByText('Project created')).toBeInTheDocument();
    expect(calls('POST', '/projects')).toHaveLength(1);
  });

  it('deletes once when the confirm button is clicked twice quickly', async () => {
    signInAs('manager');
    useApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delete Data Center Migration' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete project?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete project' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(await screen.findByText('Project deleted')).toBeInTheDocument();
    expect(calls('DELETE', '/projects/2')).toHaveLength(1);
  });

  it('sends what changed with expected_updated_at, and reloads the form when someone else got there first', async () => {
    signInAs('contributor');
    const theirs = { ...STAMPED[0], name: 'Customer Portal 2.0', updated_at: '2026-11-24T12:00:00.000000+00:00' };
    let stale = true;
    useApi({
      'PUT /projects/1': ({ body }) => {
        if (stale) {
          throw new ApiError({
            status: 409, code: 'stale_record', message: 'This project was changed by someone else after you loaded it.',
          });
        }
        return { ...theirs, ...body };
      },
      'GET /projects/1': () => theirs,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit Customer Portal Revamp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Customer Portal Revamp' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Description/ }), 'My edit');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls('PUT', '/projects/1')).toHaveLength(1));
    expect(calls('PUT', '/projects/1')[0][1].body).toEqual({
      description: 'My edit', expected_updated_at: STAMPED[0].updated_at,
    });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This was changed by someone else');
    // the dialog says it; no second message in a snackbar
    expect(screen.getAllByText(/This was changed by someone else/)).toHaveLength(1);

    stale = false;
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    const reopened = await screen.findByRole('dialog', { name: 'Edit Customer Portal 2.0' });
    expect(within(reopened).getByRole('textbox', { name: /^Name/ })).toHaveValue('Customer Portal 2.0');
    expect(calls('GET', '/projects/1')).toHaveLength(1);

    await user.type(within(reopened).getByRole('textbox', { name: /^Description/ }), 'My edit again');
    await user.click(within(reopened).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', '/projects/1')).toHaveLength(2));
    expect(calls('PUT', '/projects/1')[1][1].body).toEqual({
      description: 'My edit again', expected_updated_at: theirs.updated_at,
    });
    expect(await screen.findByText('Project updated')).toBeInTheDocument();
  });
});

describe('ProjectsPage overdue (phase 6, E4)', () => {
  const row = (table, name) => within(table).getAllByRole('row').find((r) => within(r).queryByText(name));

  it('takes overdue from the API and ignores the browser\'s date', async () => {
    signInAs('viewer');
    request.mockImplementation(async () => ({
      items: [
        // long past, but the API says it is not overdue (e.g. completed just now elsewhere)
        { ...PROJECTS[0], name: 'Past but fine', end_date: '2001-01-01', is_overdue: false, as_of: '2026-11-24' },
        // far in the future by this browser's clock, but the API says overdue
        { ...PROJECTS[1], name: 'Future but late', end_date: '2099-12-31', is_overdue: true, as_of: '2026-11-24' },
      ],
      total: 2, limit: 10, offset: 0,
    }));
    renderPage();
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(within(row(table, 'Past but fine')).queryByText('Overdue')).not.toBeInTheDocument();
    expect(within(row(table, 'Future but late')).getByText('Overdue')).toBeInTheDocument();
  });

  it('says which day overdue was judged on, in UTC', async () => {
    signInAs('viewer');
    request.mockImplementation(async () => ({
      items: PROJECTS.map((project) => ({ ...project, as_of: '2026-11-24' })), total: 2, limit: 10, offset: 0,
    }));
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    expect(screen.getByText('Overdue as of Nov 24, 2026 (UTC)')).toBeInTheDocument();
  });
});

describe('ProjectsPage sorting and paging in the URL (phase 6, F3 and F4)', () => {
  const MANY = { items: PROJECTS, total: 60, limit: 10, offset: 0 };
  const lastQuery = () => listCalls().at(-1)[1].query;
  const location = () => screen.getByTestId('location').textContent;

  function BackButton() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate(-1)}>browser back</button>;
  }

  function renderWithHistory(entry) {
    return render(
      <TestProviders initialEntries={[entry]}>
        <BackButton />
        <Routes>
          <Route path="/projects" element={<><ProjectsPage /><LocationProbe /></>} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </TestProviders>,
    );
  }

  beforeEach(() => {
    request.mockImplementation(async (path, { method = 'GET' } = {}) => (method === 'GET' ? MANY : { id: 3 }));
  });

  it('restores page, rows per page and sort from the URL, as after a reload', async () => {
    signInAs('viewer');
    renderWithHistory('/projects?status=active&page=3&per_page=25&sort=-end_date');
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(lastQuery()).toEqual({ status: 'active', sort: '-end_date', limit: 25, offset: 50 });
    expect(within(table).getByRole('columnheader', { name: 'Deadline' })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Rows per page:' })).toHaveTextContent('25');
  });

  it('shows the API default sort and sends none until the user picks one', async () => {
    signInAs('viewer');
    renderWithHistory('/projects');
    const table = await screen.findByRole('table', { name: 'Projects' });
    expect(lastQuery()).toEqual({ limit: 10, offset: 0 });
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('writes a clicked column into the URL and the request, and goes back to page one', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderWithHistory('/projects?page=2');
    const table = await screen.findByRole('table', { name: 'Projects' });

    await user.click(within(within(table).getByRole('columnheader', { name: 'Deadline' })).getByRole('button'));
    await waitFor(() => expect(lastQuery()).toEqual({ sort: 'end_date', limit: 10, offset: 0 }));
    expect(location()).toBe('/projects?sort=end_date');

    await user.click(within(screen.getByRole('columnheader', { name: 'Deadline' })).getByRole('button'));
    await waitFor(() => expect(lastQuery()).toEqual({ sort: '-end_date', limit: 10, offset: 0 }));
    expect(location()).toBe('/projects?sort=-end_date');

    // back on the default sort the parameter leaves the URL again
    await user.click(within(screen.getByRole('columnheader', { name: 'Name' })).getByRole('button'));
    await waitFor(() => expect(lastQuery()).toEqual({ limit: 10, offset: 0 }));
    expect(location()).toBe('/projects');
  });

  it('writes the page and the page size into the URL', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderWithHistory('/projects?q=portal');
    await screen.findByRole('table', { name: 'Projects' });

    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(lastQuery()).toEqual({ q: 'portal', limit: 10, offset: 10 }));
    expect(location()).toBe('/projects?q=portal&page=2');

    await user.click(screen.getByRole('combobox', { name: 'Rows per page:' }));
    await user.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => expect(lastQuery()).toEqual({ q: 'portal', limit: 50, offset: 0 }));
    expect(location()).toBe('/projects?q=portal&per_page=50');
  });

  it('goes back to the first page when a filter changes or is cleared', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderWithHistory('/projects?page=4&sort=status');
    await screen.findByRole('table', { name: 'Projects' });

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Active' }));
    await waitFor(() => expect(lastQuery()).toEqual({ status: 'active', sort: 'status', limit: 10, offset: 0 }));
    expect(location()).toBe('/projects?sort=status&status=active');

    await user.click(screen.getByRole('button', { name: 'Go to next page' }));
    await waitFor(() => expect(location()).toBe('/projects?sort=status&status=active&page=2'));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastQuery()).toEqual({ sort: 'status', limit: 10, offset: 0 }));
    expect(location()).toBe('/projects?sort=status');
  });

  it.each([
    ['an unknown sort', '/projects?sort=budget_planned', { limit: 10, offset: 0 }],
    ['a page size the list does not offer', '/projects?per_page=7', { limit: 10, offset: 0 }],
    ['a page that is not a number', '/projects?page=two', { limit: 10, offset: 0 }],
    ['a negative page', '/projects?page=-3', { limit: 10, offset: 0 }],
  ])('ignores %s in the URL', async (_name, entry, query) => {
    signInAs('viewer');
    renderWithHistory(entry);
    await screen.findByRole('table', { name: 'Projects' });
    expect(lastQuery()).toEqual(query);
  });

  it('restores the view when the user comes back with the back button', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderWithHistory('/projects?status=active&page=2&sort=-end_date');
    await screen.findByRole('table', { name: 'Projects' });

    await user.click(screen.getByRole('link', { name: 'Customer Portal Revamp' }));
    expect(location()).toBe('/projects/1');
    await user.click(screen.getByRole('button', { name: 'browser back' }));

    await screen.findByRole('table', { name: 'Projects' });
    expect(location()).toBe('/projects?status=active&page=2&sort=-end_date');
    expect(lastQuery()).toEqual({ status: 'active', sort: '-end_date', limit: 10, offset: 10 });
  });

  it('offers the same sorts in a select on a phone', async () => {
    window.innerWidth = 375;
    signInAs('viewer');
    const user = userEvent.setup();
    renderWithHistory('/projects');
    await screen.findByRole('list', { name: 'Projects' });
    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Name, ascending', 'Name, descending', 'Status, ascending', 'Status, descending',
      'Deadline, ascending', 'Deadline, descending',
    ]);
    await user.click(screen.getByRole('option', { name: 'Deadline, descending' }));
    await waitFor(() => expect(lastQuery()).toEqual({ sort: '-end_date', limit: 10, offset: 0 }));
  });
});

describe('ProjectsPage input limits (phase 6, F9)', () => {
  it('gives the planned budget a maximum and focuses the first field', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Projects' });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: /^Name/ })).toHaveFocus());
    const budget = within(dialog).getByRole('spinbutton', { name: /^Planned budget/ });
    expect(budget).toHaveAttribute('max', '999999999999.99');
    expect(budget).toHaveAttribute('min', '0');
  });
});
