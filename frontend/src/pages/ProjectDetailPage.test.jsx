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
  { id: 102, project_id: 1, title: 'Payments integration', status: 'blocked', due_date: '2020-02-01', assignee_id: 12 },
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
    useRoutes({ 'GET /projects/1': () => ({ ...PROJECT, end_date: '2020-01-01', owner_name: null }) });
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
    }));
    await waitFor(() => expect(calls('GET', '/budgets/summary').length).toBeGreaterThan(summaryLoads));
    expect(calls('GET', '/projects/1').length).toBeGreaterThan(headerLoads);
  });
});
