import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { ApiError, request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';
import { todayIso } from '../utils/format';
import ProjectDetailPage from './ProjectDetailPage';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const PROJECT = {
  id: 1,
  name: 'Mobile Banking App',
  department: 'Digital',
  description: 'A new mobile app for retail customers.',
  status: 'active',
  start_date: '2026-01-01',
  end_date: '2099-06-30',
  budget_planned: 100000,
  budget_spent: 120000,
  owner_id: 3,
  owner_name: 'Maria Gonzalez',
  percent_complete: 25,
  deliverables_total: 4,
  deliverable_counts: { not_started: 1, in_progress: 1, blocked: 1, done: 1 },
};

const PEOPLE = [
  { id: 11, full_name: 'Aisha Khan', is_active: true },
  { id: 12, full_name: 'Ben Carter', is_active: true },
  { id: 13, full_name: 'Old Timer', is_active: false },
];

const DELIVERABLES = [
  { id: 101, project_id: 1, title: 'API contract', status: 'done', due_date: '2020-01-10', assignee_id: 12 },
  // phase 6 (E4): overdue comes from the API as is_overdue, judged on as_of
  {
    id: 102, project_id: 1, title: 'Payments integration', status: 'blocked', due_date: '2020-02-01', assignee_id: 12,
    is_overdue: true, as_of: '2026-11-24',
  },
  { id: 103, project_id: 1, title: 'Security review', status: 'not_started', due_date: '2099-01-01', assignee_id: null },
];

const ALLOCATIONS = [
  {
    id: 201, resource_id: 11, project_id: 1, allocation_pct: 50,
    start_date: '2026-01-01', end_date: '2026-12-31', role_on_project: 'Lead developer',
  },
];

const ENTRIES = [
  { id: 301, project_id: 1, category: 'labor', description: 'Sprint 1', amount: 100000, spent_on: '2026-03-01' },
  { id: 302, project_id: 1, category: 'software', description: 'Licences', amount: 20000, spent_on: '2026-04-01' },
];

const SUMMARY = {
  project_id: 1, project_name: 'Mobile Banking App', planned: 100000, spent: 120000, remaining: -20000, percent_used: 120,
};

const page = (items) => ({ items, total: items.length, limit: 10, offset: 0 });

const ROUTES = {
  'GET /projects/1': () => PROJECT,
  'GET /resources': () => page(PEOPLE),
  'GET /deliverables': () => page(DELIVERABLES),
  'GET /allocations': () => page(ALLOCATIONS),
  'GET /budgets': () => page(ENTRIES),
  'GET /budgets/summary': () => SUMMARY,
};

function useRoutes(overrides = {}) {
  const routes = { ...ROUTES, ...overrides };
  request.mockImplementation(async (path, { method = 'GET', query, body } = {}) => {
    const handler = routes[`${method} ${path}`];
    if (handler) return handler({ query, body });
    if (method === 'GET') return page([]);
    if (method === 'DELETE') return null;
    return { id: 999, ...body };
  });
}

function calls(method, path) {
  return request.mock.calls.filter(([url, options = {}]) => (
    url === path && (options.method ?? 'GET') === method
  ));
}

function signInAs(role) {
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role } });
}

function renderAt(entry) {
  return render(
    <TestProviders initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:id" element={<><ProjectDetailPage /><LocationProbe /></>} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </TestProviders>,
  );
}

beforeEach(() => {
  clearSession();
  request.mockReset();
  useRoutes();
});

describe('project header', () => {
  it('shows status, dates, owner, percent complete and budget used', async () => {
    signInAs('viewer');
    renderAt('/projects/1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Mobile Banking App' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Project summary' });
    expect(within(summary).getByText('Active')).toBeInTheDocument();
    expect(within(summary).getByText('Jan 1, 2026')).toBeInTheDocument();
    expect(within(summary).getByText('Jun 30, 2099')).toBeInTheDocument();
    expect(within(summary).getByText('Maria Gonzalez')).toBeInTheDocument();
    expect(within(summary).getByRole('progressbar', { name: 'Complete' }))
      .toHaveAttribute('aria-valuetext', '25% (1 of 4 deliverables done)');
    expect(within(summary).getByText('$120,000 of $100,000 (120%)')).toBeInTheDocument();
  });

  it('marks a project whose deadline has passed', async () => {
    signInAs('viewer');
    // phase 6 (E4): the API decides what is overdue
    useRoutes({
      'GET /projects/1': () => ({ ...PROJECT, end_date: '2020-01-01', owner_name: null, is_overdue: true }),
    });
    renderAt('/projects/1');

    const summary = await screen.findByRole('region', { name: 'Project summary' });
    expect(within(summary).getByText('Overdue')).toBeInTheDocument();
    expect(within(summary).getByText('No owner')).toBeInTheDocument();
  });

  it('shows a not-found state for an unknown project', async () => {
    signInAs('viewer');
    useRoutes({
      'GET /projects/999': () => {
        throw new ApiError({ status: 404, code: 'not_found', message: 'Project 999 not found' });
      },
    });
    renderAt('/projects/999');

    expect(await screen.findByRole('heading', { level: 1, name: 'Project not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to projects' })).toHaveAttribute('href', '/projects');
    expect(calls('GET', '/deliverables')).toHaveLength(0);
  });

  it('shows the not-found state for a malformed id without calling the API', () => {
    signInAs('viewer');
    renderAt('/projects/abc');
    expect(screen.getByRole('heading', { level: 1, name: 'Project not found' })).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it('shows other load failures with a retry', async () => {
    signInAs('viewer');
    let fail = true;
    useRoutes({
      'GET /projects/1': () => {
        if (fail) throw new ApiError({ status: 500, code: 'internal_error', message: 'Server error' });
        return PROJECT;
      },
    });
    const user = userEvent.setup();
    renderAt('/projects/1');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the project');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Mobile Banking App' })).toBeInTheDocument();
  });
});

describe('project tabs', () => {
  it('opens on Deliverables and keeps the chosen tab in the URL', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1');

    expect(await screen.findByRole('tab', { name: 'Deliverables' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('table', { name: 'Deliverables' })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Team' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/1?tab=team');
    expect(await screen.findByRole('table', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Team' })).toBeInTheDocument();
  });

  it('opens the tab named in the URL', async () => {
    signInAs('viewer');
    renderAt('/projects/1?tab=budget');
    expect(await screen.findByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Budget summary' })).toBeInTheDocument();
  });
});

describe('deliverables tab', () => {
  it('lists deliverables with assignees and marks overdue ones', async () => {
    signInAs('viewer');
    renderAt('/projects/1');
    const table = await screen.findByRole('table', { name: 'Deliverables' });
    await within(table).findAllByText('Ben Carter');

    const row = (title) => within(table).getAllByRole('row').find((r) => within(r).queryByText(title));
    expect(within(row('Payments integration')).getByText('Overdue')).toBeInTheDocument();
    expect(within(row('Payments integration')).getByText('Blocked')).toBeInTheDocument();
    expect(within(row('API contract')).queryByText('Overdue')).not.toBeInTheDocument();
    expect(within(row('Security review')).queryByText('Overdue')).not.toBeInTheDocument();
    expect(within(row('Security review')).getByText('Unassigned')).toBeInTheDocument();
  });

  it('sends the project, status filter and search to the API', async () => {
    signInAs('viewer');
    renderAt('/projects/1?status=blocked&q=pay');
    await waitFor(() => expect(calls('GET', '/deliverables').length).toBeGreaterThan(0));
    expect(calls('GET', '/deliverables').at(-1)[1].query).toEqual({
      status: 'blocked', q: 'pay', project_id: 1, limit: 10, offset: 0,
    });
  });

  it('gives viewers status chips and no editing controls', async () => {
    signInAs('viewer');
    renderAt('/projects/1');
    await screen.findByRole('table', { name: 'Deliverables' });
    expect(screen.queryByRole('combobox', { name: 'Status of Security review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New deliverable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Security review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dependencies of Security review' })).toBeInTheDocument();
  });

  it('changes a status in place and refreshes the header', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderAt('/projects/1');
    await screen.findByRole('table', { name: 'Deliverables' });
    const headerLoads = calls('GET', '/projects/1').length;

    await user.click(screen.getByRole('combobox', { name: 'Status of Security review' }));
    await user.click(await screen.findByRole('option', { name: 'Done' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/deliverables/103', {
      method: 'PUT', body: { status: 'done' },
    }));
    expect(await screen.findByText('"Security review" is now done')).toBeInTheDocument();
    await waitFor(() => expect(calls('GET', '/projects/1').length).toBeGreaterThan(headerLoads));
    expect(screen.queryByRole('button', { name: 'Delete Security review' })).not.toBeInTheDocument();
  });

  it('creates a deliverable in this project with a typed assignee', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderAt('/projects/1');
    await screen.findByRole('table', { name: 'Deliverables' });

    await user.click(screen.getByRole('button', { name: 'New deliverable' }));
    const dialog = await screen.findByRole('dialog', { name: 'New deliverable' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Title/ }), 'Release notes');
    fireEvent.change(within(dialog).getByLabelText(/^Due date/), { target: { value: '2026-12-15' } });
    await user.click(within(dialog).getByRole('combobox', { name: 'Assignee' }));
    expect(screen.queryByRole('option', { name: /Old Timer/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Aisha Khan' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add deliverable' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/deliverables', {
      method: 'POST',
      body: {
        title: 'Release notes', status: 'not_started', due_date: '2026-12-15', assignee_id: 11, project_id: 1,
      },
      idempotencyKey: expect.any(String), // phase 6 (D2)
    }));
    expect(await screen.findByText('Deliverable created')).toBeInTheDocument();
  });
});

describe('team tab', () => {
  it('lists allocations with the person, role, share and dates', async () => {
    signInAs('viewer');
    renderAt('/projects/1?tab=team');
    const table = await screen.findByRole('table', { name: 'Team' });
    expect(await within(table).findByText('Aisha Khan')).toBeInTheDocument();
    expect(within(table).getByText('Lead developer')).toBeInTheDocument();
    expect(within(table).getByText('50%')).toBeInTheDocument();
    expect(within(table).getByText('Jan 1, 2026 – Dec 31, 2026')).toBeInTheDocument();
  });

  it('warns with the new total when an allocation over-books someone', async () => {
    signInAs('contributor');
    useRoutes({
      'POST /allocations': ({ body }) => ({
        id: 202, ...body, warning: 'over_allocated', total_allocation_pct: 120, capacity_pct: 100,
      }),
    });
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team');
    await screen.findByRole('table', { name: 'Team' });

    await user.click(screen.getByRole('button', { name: 'Add person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add person to project' });
    await user.click(within(dialog).getByRole('combobox', { name: /^Person/ }));
    await user.click(await screen.findByRole('option', { name: 'Aisha Khan' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: /^Allocation/ }), '70');
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/allocations', {
      method: 'POST',
      body: {
        resource_id: 11, allocation_pct: 70, start_date: '2026-01-01', end_date: '2099-06-30', project_id: 1,
      },
      idempotencyKey: expect.any(String), // phase 6 (D2)
    }));
    expect(await screen.findByText('Saved, but Aisha Khan is now booked at 120% against a capacity of 100%.'))
      .toBeInTheDocument();
  });

  it('confirms a plain save without a warning', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team');

    await user.click(await screen.findByRole('button', { name: "Edit Aisha Khan's allocation" }));
    const dialog = await screen.findByRole('dialog', { name: "Edit Aisha Khan's allocation" });
    await user.clear(within(dialog).getByRole('spinbutton', { name: /^Allocation/ }));
    await user.type(within(dialog).getByRole('spinbutton', { name: /^Allocation/ }), '40');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/allocations/201', expect.objectContaining({
      method: 'PUT', body: expect.objectContaining({ allocation_pct: 40 }),
    })));
    expect(await screen.findByText('Allocation updated')).toBeInTheDocument();
  });
});

describe('budget tab', () => {
  it('shows the summary and the entries', async () => {
    signInAs('viewer');
    renderAt('/projects/1?tab=budget');

    const summary = await screen.findByRole('region', { name: 'Budget summary' });
    expect(within(summary).getByText('Over budget by $20,000: 120% of the planned $100,000 is spent.'))
      .toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Budget entries' });
    expect(within(table).getByText('Licences')).toBeInTheDocument();
    expect(within(table).getByText('$20,000')).toBeInTheDocument();
    expect(within(table).getByText('Software')).toBeInTheDocument();
    expect(calls('GET', '/budgets/summary')[0][1].query).toEqual({ project_id: 1 });
  });

  it('filters entries by category and dates', async () => {
    signInAs('viewer');
    renderAt('/projects/1?tab=budget&category=labor&spent_from=2026-01-01&spent_to=2026-06-30');
    await waitFor(() => expect(calls('GET', '/budgets').length).toBeGreaterThan(0));
    expect(calls('GET', '/budgets').at(-1)[1].query).toEqual({
      category: 'labor', spent_from: '2026-01-01', spent_to: '2026-06-30', project_id: 1, limit: 10, offset: 0,
    });
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01');
  });

  it('adds an entry and refreshes the summary and header', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    await screen.findByRole('region', { name: 'Budget summary' });
    const summaryLoads = calls('GET', '/budgets/summary').length;
    const headerLoads = calls('GET', '/projects/1').length;

    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    const dialog = await screen.findByRole('dialog', { name: 'New budget entry' });
    expect(within(dialog).getByLabelText(/^Date spent/)).toHaveValue(todayIso());
    await user.click(within(dialog).getByRole('combobox', { name: /^Category/ }));
    await user.click(await screen.findByRole('option', { name: 'Hardware' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: /^Amount/ }), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    expect(within(dialog).getByText('Amount must be greater than 0')).toBeInTheDocument();

    await user.clear(within(dialog).getByRole('spinbutton', { name: /^Amount/ }));
    await user.type(within(dialog).getByRole('spinbutton', { name: /^Amount/ }), '1250.5');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/budgets', {
      method: 'POST',
      body: { category: 'hardware', amount: 1250.5, spent_on: todayIso(), project_id: 1 },
      idempotencyKey: expect.any(String), // phase 6 (D2)
    }));
    await waitFor(() => expect(calls('GET', '/budgets/summary').length).toBeGreaterThan(summaryLoads));
    expect(calls('GET', '/projects/1').length).toBeGreaterThan(headerLoads);
  });
});

describe('when a change is refused or the record is gone', () => {
  it('keeps the saved status and says why when a status change is refused', async () => {
    signInAs('contributor');
    useRoutes({
      'PUT /deliverables/103': () => {
        throw new ApiError({ status: 403, code: 'forbidden', message: 'This action requires the contributor role or higher' });
      },
    });
    const user = userEvent.setup();
    renderAt('/projects/1');
    await screen.findByRole('table', { name: 'Deliverables' });
    const headerLoads = calls('GET', '/projects/1').length;

    const status = screen.getByRole('combobox', { name: 'Status of Security review' });
    await user.click(status);
    await user.click(await screen.findByRole('option', { name: 'Done' }));

    expect(await screen.findByText('This action requires the contributor role or higher')).toBeInTheDocument();
    await waitFor(() => expect(status).not.toHaveAttribute('aria-disabled'));
    expect(status).toHaveTextContent('Not started');
    expect(calls('GET', '/projects/1')).toHaveLength(headerLoads);
  });

  it('lets a manager edit and then delete a deliverable', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderAt('/projects/1');
    await screen.findByRole('table', { name: 'Deliverables' });

    await user.click(screen.getByRole('button', { name: 'Edit Security review' }));
    const form = await screen.findByRole('dialog', { name: 'Edit Security review' });
    const title = within(form).getByRole('textbox', { name: /^Title/ });
    await user.clear(title);
    await user.type(title, 'Security sign-off');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', '/deliverables/103')).toHaveLength(1));
    expect(calls('PUT', '/deliverables/103')[0][1].body).toMatchObject({ title: 'Security sign-off' });
    expect(await screen.findByText('Deliverable updated')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Delete Security review' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete deliverable?' });
    expect(confirm).toHaveTextContent('"Security review" and its dependency links will be permanently deleted.');
    await user.click(within(confirm).getByRole('button', { name: 'Delete deliverable' }));
    expect(request).toHaveBeenCalledWith('/deliverables/103', { method: 'DELETE' });
    expect(await screen.findByText('Deliverable deleted')).toBeInTheDocument();
  });

  it('keeps the dialog open and reports a budget entry someone else already deleted', async () => {
    signInAs('manager');
    useRoutes({
      'DELETE /budgets/301': () => {
        throw new ApiError({ status: 404, code: 'not_found', message: 'Budget entry 301 not found' });
      },
    });
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    await screen.findByRole('table', { name: 'Budget entries' });

    await user.click(screen.getByRole('button', { name: /^Delete \$100,000 labor entry/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete budget entry?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete entry' }));

    expect(await screen.findByText('Budget entry 301 not found')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete budget entry?' })).toBeInTheDocument();
  });

  it('removes a team member after confirmation', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team');
    await screen.findByRole('table', { name: 'Team' });

    await user.click(await screen.findByRole('button', { name: "Delete Aisha Khan's allocation" }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove from project?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

    expect(request).toHaveBeenCalledWith('/allocations/201', { method: 'DELETE' });
    await waitFor(() => expect(calls('GET', '/allocations').length).toBeGreaterThan(1));
  });
});

describe('tab filters added in phase 6', () => {
  const lastQuery = (path) => calls('GET', path).at(-1)[1].query;

  it('searches budget entries by description', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    await screen.findByRole('table', { name: 'Budget entries' });
    const bar = screen.getByRole('search', { name: 'Filter budget entries' });
    await user.type(within(bar).getByRole('searchbox', { name: 'Search descriptions' }), 'licen');
    await waitFor(() => expect(lastQuery('/budgets')).toMatchObject({ q: 'licen', project_id: 1 }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/1?tab=budget&q=licen');
  });

  it('reads the budget search from the URL', async () => {
    signInAs('viewer');
    renderAt('/projects/1?tab=budget&q=sprint&category=labor');
    await screen.findByRole('table', { name: 'Budget entries' });
    expect(lastQuery('/budgets')).toEqual({ q: 'sprint', category: 'labor', project_id: 1, limit: 10, offset: 0 });
    expect(screen.getByRole('searchbox', { name: 'Search descriptions' })).toHaveValue('sprint');
  });

  it('filters the team by person and by the day an allocation is active', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team');
    await screen.findByRole('table', { name: 'Team' });
    const bar = screen.getByRole('search', { name: 'Filter team' });

    await user.click(within(bar).getByRole('combobox', { name: 'Person' }));
    await user.click(await screen.findByRole('option', { name: 'Ben Carter' }));
    await waitFor(() => expect(lastQuery('/allocations')).toMatchObject({ resource_id: '12', project_id: 1 }));

    fireEvent.change(within(bar).getByLabelText('Active on'), { target: { value: '2026-07-01' } });
    await waitFor(() => expect(lastQuery('/allocations')).toEqual({
      resource_id: '12', active_on: '2026-07-01', project_id: 1, limit: 10, offset: 0,
    }));
    expect(screen.getByTestId('location'))
      .toHaveTextContent('/projects/1?tab=team&resource_id=12&active_on=2026-07-01');
  });

  it('offers to clear the team filters when no allocation matches', async () => {
    signInAs('viewer');
    useRoutes({ 'GET /allocations': ({ query }) => page(query.resource_id ? [] : ALLOCATIONS) });
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team&resource_id=12');
    expect(await screen.findByText('No allocations match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByRole('table', { name: 'Team' })).toBeInTheDocument();
  });

  it('starts the next tab without the previous tab\'s filters', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?q=security&status=blocked');
    await screen.findByRole('table', { name: 'Deliverables' });
    await user.click(screen.getByRole('tab', { name: 'Budget' }));
    await screen.findByRole('table', { name: 'Budget entries' });
    expect(screen.getByTestId('location')).toHaveTextContent(/\/projects\/1\?tab=budget$/);
    expect(lastQuery('/budgets')).toEqual({ project_id: 1, limit: 10, offset: 0 });
  });
});

describe('quick status change and lost updates (phase 6, D3)', () => {
  const STAMPED = DELIVERABLES.map((item) => ({ ...item, updated_at: '2026-11-24T10:00:00.000000+00:00' }));

  it('sends expected_updated_at with a quick status change', async () => {
    signInAs('contributor');
    useRoutes({ 'GET /deliverables': () => page(STAMPED) });
    const user = userEvent.setup();
    renderAt('/projects/1');
    await user.click(await screen.findByRole('combobox', { name: 'Status of Security review' }));
    await user.click(await screen.findByRole('option', { name: 'In progress' }));
    await waitFor(() => expect(calls('PUT', '/deliverables/103')).toHaveLength(1));
    expect(calls('PUT', '/deliverables/103')[0][1].body).toEqual({
      status: 'in_progress', expected_updated_at: '2026-11-24T10:00:00.000000+00:00',
    });
  });

  it('says someone else changed it and reloads the list from the message', async () => {
    signInAs('contributor');
    useRoutes({
      'GET /deliverables': () => page(STAMPED),
      'PUT /deliverables/103': () => {
        throw new ApiError({
          status: 409, code: 'stale_record', message: 'This deliverable was changed by someone else after you loaded it.',
        });
      },
    });
    const user = userEvent.setup();
    renderAt('/projects/1');
    await user.click(await screen.findByRole('combobox', { name: 'Status of Security review' }));
    await user.click(await screen.findByRole('option', { name: 'Done' }));

    const message = await screen.findByText('This was changed by someone else');
    const loads = calls('GET', '/deliverables').length;
    const snackbar = message.closest('[role="status"], [role="alert"]');
    await user.click(within(snackbar).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls('GET', '/deliverables').length).toBeGreaterThan(loads));
    await waitFor(() => expect(screen.queryByText('This was changed by someone else')).not.toBeInTheDocument());
    // the select still shows the saved status
    expect(within(screen.getByRole('combobox', { name: 'Status of Security review' })).getByText('Not started'))
      .toBeInTheDocument();
  });

  it('edits a deliverable with only the changed field and its expected_updated_at', async () => {
    signInAs('contributor');
    useRoutes({ 'GET /deliverables': () => page(STAMPED) });
    const user = userEvent.setup();
    renderAt('/projects/1');
    await user.click(await screen.findByRole('button', { name: 'Edit Security review' }));
    const form = await screen.findByRole('dialog', { name: 'Edit Security review' });
    await user.type(within(form).getByRole('textbox', { name: /^Title/ }), ' v2');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', '/deliverables/103')).toHaveLength(1));
    expect(calls('PUT', '/deliverables/103')[0][1].body).toEqual({
      title: 'Security review v2', expected_updated_at: '2026-11-24T10:00:00.000000+00:00',
    });
  });
});

describe('overdue comes from the API (phase 6, E4)', () => {
  it('shows the day overdue was judged on in the header and under the deliverables', async () => {
    signInAs('viewer');
    useRoutes({
      'GET /projects/1': () => ({ ...PROJECT, is_overdue: false, as_of: '2026-11-24' }),
      'GET /deliverables': () => page(DELIVERABLES.map((item) => ({ ...item, as_of: '2026-11-24' }))),
    });
    renderAt('/projects/1');
    const summary = await screen.findByRole('region', { name: 'Project summary' });
    expect(within(summary).getByText('Overdue as of Nov 24, 2026 (UTC)')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Deliverables' });
    expect(screen.getAllByText('Overdue as of Nov 24, 2026 (UTC)')).toHaveLength(2);
  });

  it('does not work overdue out from the browser\'s date', async () => {
    signInAs('viewer');
    useRoutes({
      'GET /projects/1': () => ({ ...PROJECT, end_date: '2001-01-01', is_overdue: false }),
      'GET /deliverables': () => page([
        { id: 101, project_id: 1, title: 'Old but fine', status: 'in_progress', due_date: '2001-01-01', is_overdue: false },
        { id: 102, project_id: 1, title: 'Future but late', status: 'in_progress', due_date: '2099-01-01', is_overdue: true },
      ]),
    });
    renderAt('/projects/1');
    const summary = await screen.findByRole('region', { name: 'Project summary' });
    expect(within(summary).queryByText('Overdue')).not.toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Deliverables' });
    const row = (title) => within(table).getAllByRole('row').find((r) => within(r).queryByText(title));
    await waitFor(() => expect(row('Future but late')).toBeTruthy());
    expect(within(row('Old but fine')).queryByText('Overdue')).not.toBeInTheDocument();
    expect(within(row('Future but late')).getByText('Overdue')).toBeInTheDocument();
  });
});

describe('sorting, the timeout message and input limits (phase 6, F3, F8, F9)', () => {
  const lastQuery = (path) => calls('GET', path).at(-1)[1].query;
  const sortBy = async (user, table, column) => {
    await user.click(within(within(table).getByRole('columnheader', { name: column })).getByRole('button'));
  };

  it('sorts deliverables, keeping the tab and the filters in the URL', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?status=blocked');
    const table = await screen.findByRole('table', { name: 'Deliverables' });
    expect(within(table).getByRole('columnheader', { name: 'Due' })).toHaveAttribute('aria-sort', 'ascending');
    await sortBy(user, table, 'Deliverable');
    await waitFor(() => expect(lastQuery('/deliverables')).toEqual({
      status: 'blocked', project_id: 1, sort: 'title', limit: 10, offset: 0,
    }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/1?status=blocked&sort=title');
  });

  it('sorts the team by allocation and by dates', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=team');
    const table = await screen.findByRole('table', { name: 'Team' });
    await sortBy(user, table, 'Allocation');
    await waitFor(() => expect(lastQuery('/allocations')).toMatchObject({ sort: 'allocation_pct' }));
    await sortBy(user, screen.getByRole('table', { name: 'Team' }), 'Allocation');
    await waitFor(() => expect(lastQuery('/allocations')).toMatchObject({ sort: '-allocation_pct' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/1?tab=team&sort=-allocation_pct');
  });

  it('sorts budget entries and starts from the newest', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    const table = await screen.findByRole('table', { name: 'Budget entries' });
    expect(within(table).getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending');
    await sortBy(user, table, 'Amount');
    await waitFor(() => expect(lastQuery('/budgets')).toMatchObject({ sort: 'amount' }));
  });

  it('drops the sort of one tab when another tab is opened', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderAt('/projects/1?sort=title&page=2');
    await screen.findByRole('table', { name: 'Deliverables' });
    await user.click(screen.getByRole('tab', { name: 'Budget' }));
    await screen.findByRole('table', { name: 'Budget entries' });
    expect(lastQuery('/budgets')).toEqual({ project_id: 1, limit: 10, offset: 0 });
  });

  it('says the server took too long, and Retry loads the list', async () => {
    signInAs('viewer');
    let slow = true;
    useRoutes({
      'GET /deliverables': () => {
        if (slow) {
          throw new ApiError({ status: 0, code: 'timeout', message: 'The server took too long to answer. Try again.' });
        }
        return page(DELIVERABLES);
      },
    });
    const user = userEvent.setup();
    renderAt('/projects/1');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server took too long to answer. Try again.');
    slow = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Deliverables' })).toBeInTheDocument();
    expect(await screen.findByText('Security review')).toBeInTheDocument();
  });

  it('gives the budget amount a maximum', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    await screen.findByRole('region', { name: 'Budget summary' });
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    const dialog = await screen.findByRole('dialog', { name: 'New budget entry' });
    const amount = within(dialog).getByRole('spinbutton', { name: /^Amount/ });
    expect(amount).toHaveAttribute('max', '999999999999.99');
    await user.type(amount, '1000000000000');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    expect(within(dialog).getByText('Amount (USD) must be at most 999999999999.99')).toBeInTheDocument();
    expect(calls('POST', '/budgets')).toHaveLength(0);
  });
});

describe('reload after a stale edit, on every tab (phase 6, D3)', () => {
  const STAMP = '2026-11-24T10:00:00.000000+00:00';
  const LATER = '2026-11-24T12:00:00.000000+00:00';
  const stale = () => {
    throw new ApiError({ status: 409, code: 'stale_record', message: 'Changed by someone else after you loaded it.' });
  };

  it.each([
    {
      tab: 'deliverables', table: 'Deliverables', path: '/deliverables', id: 103,
      rows: () => DELIVERABLES.map((item) => ({ ...item, updated_at: STAMP })),
      edit: 'Edit Security review', dialog: 'Edit Security review', field: /^Title/, theirs: { title: 'Security audit' },
      reopened: 'Edit Security audit', value: 'Security audit',
    },
    {
      tab: 'team', table: 'Team', path: '/allocations', id: 201,
      rows: () => ALLOCATIONS.map((item) => ({ ...item, updated_at: STAMP })),
      edit: "Edit Aisha Khan's allocation", dialog: "Edit Aisha Khan's allocation", field: /^Role on project/,
      theirs: { role_on_project: 'Architect' }, reopened: "Edit Aisha Khan's allocation", value: 'Architect',
    },
    {
      tab: 'budget', table: 'Budget entries', path: '/budgets', id: 301,
      rows: () => ENTRIES.map((item) => ({ ...item, updated_at: STAMP })),
      edit: /^Edit \$100,000 labor entry/, dialog: 'Edit budget entry', field: /^Description/,
      theirs: { description: 'Sprint 1 and 2' }, reopened: 'Edit budget entry', value: 'Sprint 1 and 2',
    },
  ])('$table: says someone else changed it, reloads the record and saves against the fresh copy', async (spec) => {
    signInAs('manager');
    const fresh = { ...spec.rows().find((row) => row.id === spec.id), ...spec.theirs, updated_at: LATER };
    let first = true;
    useRoutes({
      [`GET ${spec.path}`]: () => page(spec.rows()),
      [`GET ${spec.path}/${spec.id}`]: () => fresh,
      [`PUT ${spec.path}/${spec.id}`]: ({ body }) => {
        if (first) {
          first = false;
          return stale();
        }
        return { ...fresh, ...body };
      },
    });
    const user = userEvent.setup();
    renderAt(`/projects/1?tab=${spec.tab}`);
    await user.click(await screen.findByRole('button', { name: spec.edit }));
    const dialog = await screen.findByRole('dialog', { name: spec.dialog });
    await user.type(within(dialog).getByRole('textbox', { name: spec.field }), ' (mine)');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This was changed by someone else');
    expect(calls('PUT', `${spec.path}/${spec.id}`)[0][1].body.expected_updated_at).toBe(STAMP);

    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    const reopened = await screen.findByRole('dialog', { name: spec.reopened });
    await waitFor(() => expect(within(reopened).getByRole('textbox', { name: spec.field })).toHaveValue(spec.value));
    expect(calls('GET', `${spec.path}/${spec.id}`)).toHaveLength(1);

    await user.type(within(reopened).getByRole('textbox', { name: spec.field }), '!');
    await user.click(within(reopened).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', `${spec.path}/${spec.id}`)).toHaveLength(2));
    expect(calls('PUT', `${spec.path}/${spec.id}`)[1][1].body.expected_updated_at).toBe(LATER);
  });

  it('deletes a budget entry and refreshes the summary', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderAt('/projects/1?tab=budget');
    await user.click(await screen.findByRole('button', { name: /^Delete \$100,000 labor entry/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete budget entry?' });
    const loads = calls('GET', '/budgets/summary').length;
    await user.click(within(confirm).getByRole('button', { name: 'Delete entry' }));
    expect(await screen.findByText('Budget entry deleted')).toBeInTheDocument();
    await waitFor(() => expect(calls('GET', '/budgets/summary').length).toBeGreaterThan(loads));
  });

  it('clears the deliverable filters from the empty state', async () => {
    signInAs('viewer');
    useRoutes({ 'GET /deliverables': ({ query }) => page(query.status ? [] : DELIVERABLES) });
    const user = userEvent.setup();
    renderAt('/projects/1?status=blocked&page=3');
    expect(await screen.findByText('No deliverables match these filters')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1));
    expect(await screen.findByRole('table', { name: 'Deliverables' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(/\/projects\/1$/);
  });
});
