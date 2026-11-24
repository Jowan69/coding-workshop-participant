import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { request } from '../services/apiClient';
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
      },
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
      body: expect.objectContaining({ name: 'Customer Portal Revamp 2', department: 'Digital' }),
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
