import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders from '../../TestProviders';
import { ApiError, request } from '../../services/apiClient';
import { clearSession, setSession } from '../../services/session';
import AllocationSection from './AllocationSection';
import AtRiskSection from './AtRiskSection';
import BudgetSection from './BudgetSection';
import DeliverablesSection from './DeliverablesSection';
import DependencySection from './DependencySection';
import OverAllocatedSection from './OverAllocatedSection';
import ProjectStatusSection from './ProjectStatusSection';

vi.mock('../../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const AS_OF = '2026-11-24';
const page = (items) => ({ items, total: items.length, limit: 100, offset: 0 });

const STATUS = {
  as_of: AS_OF,
  items: [
    {
      id: 2, name: 'Data Center Migration', department: 'Operations', status: 'active',
      start_date: '2026-06-27', end_date: '2026-11-14', days_to_deadline: -10,
      deliverables_total: 4, deliverables_done: 2, percent_done: 50, time_elapsed_pct: 100, health: 'overdue',
    },
    {
      id: 1, name: 'Customer Portal Revamp', department: 'Engineering', status: 'active',
      start_date: '2026-09-25', end_date: '2027-02-22', days_to_deadline: 90,
      deliverables_total: 4, deliverables_done: 2, percent_done: 50, time_elapsed_pct: 40, health: 'on_track',
    },
    {
      id: 6, name: 'Market Expansion Study', department: 'Marketing', status: 'planned',
      start_date: '2026-12-14', end_date: '2027-04-13', days_to_deadline: 140,
      deliverables_total: 0, deliverables_done: 0, percent_done: null, time_elapsed_pct: 0, health: 'on_track',
    },
  ],
};

const AT_RISK = {
  as_of: AS_OF,
  items: [
    {
      ...STATUS.items[0],
      forecast_end_date: '2027-04-23',
      reasons: [
        { code: 'deadline_passed', message: 'Deadline passed 10 days ago' },
        { code: 'overdue_deliverables', message: '2 deliverables past due' },
      ],
    },
    {
      id: 3, name: 'Mobile Banking App', department: 'Engineering', status: 'active',
      start_date: '2026-08-26', end_date: '2026-12-24', days_to_deadline: 30,
      deliverables_total: 2, deliverables_done: 0, percent_done: 0, time_elapsed_pct: 75, health: 'at_risk',
      forecast_end_date: null,
      reasons: [{ code: 'blocked_deliverables', message: '1 deliverable blocked' }],
    },
  ],
};

const EMMA = {
  id: 15, full_name: 'Emma Wilson', capacity_pct: 100, total_pct: 0, over_capacity: false, cells: [],
};
const ALLOCATION = {
  on: AS_OF,
  projects: [{ id: 1, name: 'Customer Portal Revamp' }, { id: 3, name: 'Mobile Banking App' }],
  resources: [
    {
      id: 11, full_name: 'Aisha Khan', capacity_pct: 100, total_pct: 120, over_capacity: true,
      cells: [{ project_id: 1, allocation_pct: 60 }, { project_id: 3, allocation_pct: 60 }],
    },
    EMMA,
  ],
};

const DELIVERABLES = {
  as_of: AS_OF,
  items: [
    {
      project_id: 3, project_name: 'Mobile Banking App', project_status: 'active', total: 5,
      counts: { not_started: 2, in_progress: 1, blocked: 1, done: 1 }, percent_done: 20, overdue: 2,
      next_due: { id: 11, title: 'Security review', status: 'not_started', due_date: '2026-12-04' },
    },
    {
      project_id: 6, project_name: 'Market Expansion Study', project_status: 'planned', total: 0,
      counts: { not_started: 0, in_progress: 0, blocked: 0, done: 0 }, percent_done: null, overdue: 0,
      next_due: null,
    },
  ],
};

const OVER_ALLOCATED = {
  from: AS_OF,
  to: '2027-02-22',
  items: [
    {
      resource_id: 11, full_name: 'Aisha Khan', capacity_pct: 100, peak_pct: 120, peak_on: AS_OF,
      overlap_start: '2026-09-25', overlap_end: '2026-12-24',
      projects: [
        { project_id: 1, project_name: 'Customer Portal Revamp', allocation_pct: 60 },
        { project_id: 3, project_name: 'Mobile Banking App', allocation_pct: 60 },
      ],
    },
  ],
};

const PICKER_PROJECTS = page([
  { id: 4, name: 'Brand Refresh Campaign' },
  { id: 3, name: 'Mobile Banking App' },
]);

const chainItem = (id, title, status, depth, dependsOn = [], upstream = [], blocked = false) => ({
  id, title, status, due_date: '2026-12-01', depth, depends_on_ids: dependsOn, upstream_ids: upstream,
  blocked_by_upstream: blocked,
});

const CHAINS = {
  4: {
    project_id: 4,
    project_name: 'Brand Refresh Campaign',
    items: [chainItem(14, 'Brand guidelines', 'done', 0)],
    longest_chain: [14],
  },
  3: {
    project_id: 3,
    project_name: 'Mobile Banking App',
    items: [
      chainItem(9, 'API contract', 'done', 0),
      chainItem(13, 'Push notifications', 'in_progress', 0),
      chainItem(10, 'Payments integration', 'blocked', 1, [9], [9]),
      chainItem(11, 'Security review', 'not_started', 2, [10], [9, 10], true),
      chainItem(12, 'App store submission', 'not_started', 3, [11], [9, 10, 11], true),
    ],
    longest_chain: [9, 10, 11, 12],
  },
};

const BUDGET = {
  as_of: AS_OF,
  items: [
    {
      project_id: 4, project_name: 'Brand Refresh Campaign', project_status: 'active', planned: 80000,
      spent: 96500, remaining: -16500, percent_used: 120.6, over_budget: true, time_elapsed_pct: 62.5,
      burn_gap_pts: 58.1,
    },
    {
      project_id: 1, project_name: 'Customer Portal Revamp', project_status: 'active', planned: 250000,
      spent: 89700, remaining: 160300, percent_used: 35.9, over_budget: false, time_elapsed_pct: 40,
      burn_gap_pts: -4.1,
    },
  ],
};

const ROUTES = {
  '/insights/project-status': () => STATUS,
  '/insights/at-risk': () => AT_RISK,
  '/insights/allocation': () => ALLOCATION,
  '/insights/deliverables': () => DELIVERABLES,
  '/insights/over-allocated': () => OVER_ALLOCATED,
  '/insights/dependencies': ({ query }) => CHAINS[query.project_id],
  '/insights/budget': () => BUDGET,
  '/projects': () => PICKER_PROJECTS,
};

function useRoutes(overrides = {}) {
  const routes = { ...ROUTES, ...overrides };
  request.mockImplementation(async (path, { query } = {}) => routes[path]({ query: query ?? {} }));
}

function callsTo(path) {
  return request.mock.calls.filter(([url]) => url === path);
}

function renderSection(Component) {
  render(<TestProviders><Component /></TestProviders>);
}

const serverError = () => {
  throw new ApiError({ status: 500, code: 'internal_error', message: 'Server unavailable' });
};

beforeEach(() => {
  clearSession();
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role: 'viewer' } });
  request.mockReset();
});

const SECTIONS = [
  {
    Component: ProjectStatusSection,
    heading: 'What is the status of each active project?',
    path: '/insights/project-status',
    label: 'project status',
    shows: 'Data Center Migration',
    empty: { as_of: AS_OF, items: [] },
    emptyText: 'No active projects.',
  },
  {
    Component: AtRiskSection,
    heading: 'Which projects are at risk?',
    path: '/insights/at-risk',
    label: 'at-risk projects',
    shows: 'Deadline passed 10 days ago',
    empty: { as_of: AS_OF, items: [] },
    emptyText: 'No project is at risk: every open project is on track.',
  },
  {
    Component: AllocationSection,
    heading: 'Who is allocated to which project?',
    path: '/insights/allocation',
    label: 'the allocation matrix',
    shows: 'Aisha Khan',
    empty: { on: AS_OF, projects: [], resources: [EMMA] },
    emptyText: 'Nobody is allocated to a project on Nov 24, 2026.',
  },
  {
    Component: DeliverablesSection,
    heading: 'How are deliverables progressing?',
    path: '/insights/deliverables',
    label: 'deliverable progress',
    shows: 'Security review',
    empty: { as_of: AS_OF, items: [] },
    emptyText: 'No open projects, so no deliverables to track.',
  },
  {
    Component: OverAllocatedSection,
    heading: 'Who is over-allocated?',
    path: '/insights/over-allocated',
    label: 'over-allocated people',
    shows: 'Aisha Khan',
    empty: { from: AS_OF, to: '2027-02-22', items: [] },
    emptyText: 'Nobody is booked above capacity between Nov 24, 2026 and Feb 22, 2027.',
  },
  {
    Component: DependencySection,
    heading: 'What is holding up each deliverable?',
    path: '/insights/dependencies',
    label: 'the dependency chain',
    shows: 'Brand guidelines',
    empty: { project_id: 4, project_name: 'Brand Refresh Campaign', items: [], longest_chain: [] },
    emptyText: 'Brand Refresh Campaign has no deliverables yet.',
  },
  {
    Component: BudgetSection,
    heading: 'Are projects within budget?',
    path: '/insights/budget',
    label: 'budgets',
    shows: 'Brand Refresh Campaign',
    empty: { as_of: AS_OF, items: [] },
    emptyText: 'No projects yet, so no budgets to compare.',
  },
];

describe.each(SECTIONS)('$heading', ({ Component, heading, path, label, shows, empty, emptyText }) => {
  it('loads, then shows its answer under the question', async () => {
    useRoutes();
    renderSection(Component);
    const section = screen.getByRole('region', { name: heading });
    expect(within(section).getByTestId('section-loading')).toBeInTheDocument();
    expect(await within(section).findByText(shows)).toBeInTheDocument();
    expect(within(section).queryByTestId('section-loading')).not.toBeInTheDocument();
    expect(callsTo(path).length).toBeGreaterThan(0);
  });

  it('shows its own empty state', async () => {
    useRoutes({ [path]: () => empty });
    renderSection(Component);
    expect(await screen.findByText(emptyText)).toBeInTheDocument();
    expect(screen.queryByText(shows)).not.toBeInTheDocument();
  });

  it('shows its own error with a Retry that asks again', async () => {
    const user = userEvent.setup();
    let failing = true;
    useRoutes({ [path]: (args) => (failing ? serverError() : ROUTES[path](args)) });
    renderSection(Component);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`Could not load ${label}`);
    expect(alert).toHaveTextContent('Server unavailable');

    failing = false;
    const before = callsTo(path).length;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(shows)).toBeInTheDocument();
    expect(callsTo(path).length).toBe(before + 1);
  });
});

describe('ProjectStatusSection', () => {
  it('shows status and health chips, progress and days to the deadline', async () => {
    useRoutes();
    renderSection(ProjectStatusSection);
    const table = await screen.findByRole('table', { name: 'Project status' });
    const migration = within(table).getByRole('row', { name: /Data Center Migration/ });
    expect(within(migration).getByText('Active')).toBeInTheDocument();
    expect(within(migration).getByText('Overdue')).toBeInTheDocument();
    expect(within(migration).getByText('10 days overdue')).toBeInTheDocument();
    expect(within(migration).getByRole('progressbar', { name: 'Data Center Migration deliverables done' }))
      .toHaveAttribute('aria-valuetext', '2 of 4 (50%)');
    expect(within(migration).getByRole('link', { name: 'Data Center Migration' }))
      .toHaveAttribute('href', '/projects/2');
    const study = within(table).getByRole('row', { name: /Market Expansion Study/ });
    expect(within(study).getByText('No deliverables')).toBeInTheDocument();
    expect(within(study).getByText('On track')).toBeInTheDocument();
  });
});

describe('ProjectStatusSection status toggle and forecast', () => {
  const lastQuery = () => callsTo('/insights/project-status').at(-1)[1].query;

  it('asks for active projects first and for another status when toggled', async () => {
    const user = userEvent.setup();
    useRoutes();
    renderSection(ProjectStatusSection);
    await screen.findByRole('table', { name: 'Project status' });
    expect(lastQuery()).toEqual({ status: 'active' });
    const toggle = screen.getByRole('group', { name: 'Projects to show' });
    expect(within(toggle).getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(toggle).getByRole('button', { name: 'Planned' }));
    await waitFor(() => expect(lastQuery()).toEqual({ status: 'planned' }));
    expect(within(toggle).getByRole('button', { name: 'Planned' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/^Showing planned projects/)).toBeInTheDocument();

    await user.click(within(toggle).getByRole('button', { name: 'On hold' }));
    await waitFor(() => expect(lastQuery()).toEqual({ status: 'on_hold' }));
    await user.click(within(toggle).getByRole('button', { name: 'All open' }));
    await waitFor(() => expect(lastQuery()).toEqual({ status: '' }));
  });

  it('keeps one choice selected when the selected one is clicked again', async () => {
    const user = userEvent.setup();
    useRoutes();
    renderSection(ProjectStatusSection);
    await screen.findByRole('table', { name: 'Project status' });
    const active = screen.getByRole('button', { name: 'Active' });
    await user.click(active);
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(callsTo('/insights/project-status')).toHaveLength(1);
  });

  it('names the status in the empty message', async () => {
    const user = userEvent.setup();
    useRoutes({ '/insights/project-status': () => ({ as_of: AS_OF, items: [] }) });
    renderSection(ProjectStatusSection);
    expect(await screen.findByText('No active projects.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'On hold' }));
    expect(await screen.findByText('No on-hold projects.')).toBeInTheDocument();
  });

  it('shows the forecast finish as +N days against the deadline', async () => {
    const [migration, portal, study] = STATUS.items;
    useRoutes({
      '/insights/project-status': () => ({
        as_of: AS_OF,
        items: [
          { ...migration, forecast_end_date: '2027-04-23' },
          { ...portal, forecast_end_date: '2027-01-23' },
          { ...study, forecast_end_date: null },
          { ...portal, id: 7, name: 'One Day Late', end_date: '2027-02-22', forecast_end_date: '2027-02-23' },
        ],
      }),
    });
    renderSection(ProjectStatusSection);
    const table = await screen.findByRole('table', { name: 'Project status' });
    expect(within(table).getByRole('columnheader', { name: 'Forecast' })).toBeInTheDocument();
    const late = within(table).getByRole('row', { name: /Data Center Migration/ });
    expect(within(late).getByText('Apr 23, 2027')).toBeInTheDocument();
    expect(within(late).getByText('+160 days')).toBeInTheDocument();
    const onTime = within(table).getByRole('row', { name: /Customer Portal Revamp/ });
    expect(within(onTime).getByText('Jan 23, 2027')).toBeInTheDocument();
    expect(within(onTime).getByText('On time')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /Market Expansion Study/ }))
      .getByText('No forecast yet')).toBeInTheDocument();
    expect(within(within(table).getByRole('row', { name: /One Day Late/ })).getByText('+1 day'))
      .toBeInTheDocument();
  });
});

describe('the day overdue was judged on (phase 6, E4)', () => {
  it.each([
    ['project status', ProjectStatusSection],
    ['at-risk projects', AtRiskSection],
    ['deliverable progress', DeliverablesSection],
  ])('is shown under %s', async (_name, Section) => {
    useRoutes();
    renderSection(Section);
    expect(await screen.findByText('Overdue as of Nov 24, 2026 (UTC)')).toBeInTheDocument();
  });
});

describe('AtRiskSection', () => {
  it('lists reason chips and the forecast against the deadline', async () => {
    useRoutes();
    renderSection(AtRiskSection);
    const reasons = await screen.findByRole('list', { name: 'Why Data Center Migration is at risk' });
    expect(within(reasons).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Deadline passed 10 days ago', '2 deliverables past due',
    ]);
    expect(screen.getByText('Forecast finish Apr 23, 2027')).toBeInTheDocument();
    expect(screen.getByText(/160 days after the deadline\) · deadline Nov 14, 2026/)).toBeInTheDocument();
    expect(screen.getByText('No forecast until a deliverable is done · deadline Dec 24, 2026'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mobile Banking App' })).toHaveAttribute('href', '/projects/3');
  });

  it('lets a long reason wrap instead of widening the page on a phone', async () => {
    window.innerWidth = 360;
    useRoutes();
    renderSection(AtRiskSection);
    const label = await screen.findByText('Deadline passed 10 days ago');
    // A chip label is nowrap by default; at 360px a long reason made the page scroll sideways.
    expect(label).toHaveStyle({ whiteSpace: 'normal' });
    expect(label.closest('.MuiChip-root')).toHaveStyle({ maxWidth: '100%', height: 'auto' });
  });
});

describe('AllocationSection', () => {
  it('draws the person-by-project matrix inside its own scrollable region', async () => {
    useRoutes();
    renderSection(AllocationSection);
    const region = await screen.findByRole('region', { name: 'Allocation matrix' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveStyle({ overflowX: 'auto' });
    const table = within(region).getByRole('table', { name: 'Allocation on Nov 24, 2026' });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(['Person', 'Customer Portal Revamp', 'Mobile Banking App', 'Total']);

    const aisha = within(table).getByRole('row', { name: /Aisha Khan/ });
    expect(within(aisha).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['60%', '60%', '120%Over-allocated']);
    const emma = within(table).getByRole('row', { name: /Emma Wilson/ });
    expect(within(emma).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['—', '—', '0%']);
  });

  it('asks for another day when the date changes', async () => {
    useRoutes();
    renderSection(AllocationSection);
    await screen.findByRole('region', { name: 'Allocation matrix' });
    fireEvent.change(screen.getByLabelText('On date'), { target: { value: '2026-12-19' } });
    await waitFor(() => expect(callsTo('/insights/allocation').at(-1)[1].query).toEqual({ on: '2026-12-19' }));
  });

  it('keeps the matrix scrolling sideways on a phone', async () => {
    window.innerWidth = 375;
    useRoutes();
    renderSection(AllocationSection);
    const region = await screen.findByRole('region', { name: 'Allocation matrix' });
    expect(within(region).getByRole('table')).toBeInTheDocument();
    expect(region).toHaveStyle({ overflowX: 'auto' });
  });
});

describe('DeliverablesSection', () => {
  it('shows progress, counts by status, overdue and the next due item', async () => {
    useRoutes();
    renderSection(DeliverablesSection);
    const table = await screen.findByRole('table', { name: 'Deliverable progress' });
    const banking = within(table).getByRole('row', { name: /Mobile Banking App/ });
    expect(within(banking).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1 of 5 done');
    expect(within(banking).getByText('2 not started · 1 in progress · 1 blocked · 1 done')).toBeInTheDocument();
    expect(within(banking).getByText('2 overdue')).toBeInTheDocument();
    expect(within(banking).getByText('Due Dec 4, 2026')).toBeInTheDocument();
    expect(within(banking).getByRole('link', { name: 'Mobile Banking App' }))
      .toHaveAttribute('href', '/projects/3?tab=deliverables');
    const study = within(table).getByRole('row', { name: /Market Expansion Study/ });
    expect(within(study).getByText('No deliverables')).toBeInTheDocument();
    expect(within(study).getByText('Nothing upcoming')).toBeInTheDocument();
    expect(within(study).getByText('None')).toBeInTheDocument();
  });
});

describe('OverAllocatedSection', () => {
  it('shows the peak, the overlap and the projects behind it', async () => {
    useRoutes();
    renderSection(OverAllocatedSection);
    const table = await screen.findByRole('table', { name: 'Over-allocated people' });
    const aisha = within(table).getByRole('row', { name: /Aisha Khan/ });
    expect(within(aisha).getByText('120% booked')).toBeInTheDocument();
    expect(within(aisha).getByText('Capacity 100% · peak from Nov 24, 2026')).toBeInTheDocument();
    expect(within(aisha).getByText('Sep 25, 2026 – Dec 24, 2026')).toBeInTheDocument();
    expect(within(aisha).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Customer Portal Revamp: 60%', 'Mobile Banking App: 60%',
    ]);
    expect(screen.getByText('Checked from Nov 24, 2026 to Feb 22, 2027.')).toBeInTheDocument();
  });
});

describe('DependencySection', () => {
  it('starts with the first project and switches with the picker', async () => {
    const user = userEvent.setup();
    useRoutes();
    renderSection(DependencySection);
    expect(await screen.findByText('No deliverable in this project depends on another.')).toBeInTheDocument();
    expect(callsTo('/insights/dependencies')[0][1].query).toEqual({ project_id: 4 });

    await user.click(screen.getByRole('combobox', { name: 'Project' }));
    await user.click(await screen.findByRole('option', { name: 'Mobile Banking App' }));

    const list = await screen.findByRole('list', { name: 'Dependency chain of Mobile Banking App' });
    expect(callsTo('/insights/dependencies').at(-1)[1].query).toEqual({ project_id: 3 });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => [row.getAttribute('aria-level'), row.querySelector('p').textContent])).toEqual([
      ['1', 'API contract'],
      ['2', 'Payments integration'],
      ['3', 'Security review'],
      ['4', 'App store submission'],
      ['1', 'Push notifications'],
    ]);
    expect(within(list).getAllByText('Blocked by Payments integration')).toHaveLength(2);
    expect(within(list).getAllByText('Blocked by Payments integration')[0]).toHaveStyle({ whiteSpace: 'normal' });
    expect(within(rows[1]).queryByText(/Blocked by/)).not.toBeInTheDocument();
    expect(screen.getByText(
      'API contract → Payments integration → Security review → App store submission (3 links)',
    )).toBeInTheDocument();
  });

  it('says so when the projects to choose from cannot load, and retries', async () => {
    const user = userEvent.setup();
    let failing = true;
    useRoutes({ '/projects': () => (failing ? serverError() : PICKER_PROJECTS) });
    renderSection(DependencySection);
    expect(await screen.findByText(/Could not load the projects to choose from/)).toBeInTheDocument();
    expect(callsTo('/insights/dependencies')).toHaveLength(0);

    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Brand guidelines')).toBeInTheDocument();
  });

  it('says there is nothing to show without projects', async () => {
    useRoutes({ '/projects': () => page([]) });
    renderSection(DependencySection);
    expect(await screen.findByText('No projects yet, so no dependencies to show.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
  });
});

describe('BudgetSection', () => {
  it('compares planned with spent and the burn with time elapsed', async () => {
    useRoutes();
    renderSection(BudgetSection);
    const table = await screen.findByRole('table', { name: 'Budgets' });
    const brand = within(table).getByRole('row', { name: /Brand Refresh Campaign/ });
    const spent = within(brand).getByRole('progressbar', { name: 'Brand Refresh Campaign budget used' });
    expect(spent).toHaveAttribute('aria-valuetext', '$96,500 of $80,000 (121%)');
    expect(spent.className).toMatch(/colorOverdue/);
    expect(within(brand).getByRole('progressbar', { name: 'Brand Refresh Campaign time elapsed' }))
      .toHaveAttribute('aria-valuetext', '63% of time elapsed');
    expect(within(brand).getByText('Spending 58.1 pts ahead of time')).toBeInTheDocument();
    expect(within(brand).getByText('Over budget')).toBeInTheDocument();
    expect(within(brand).getByText('$16,500 over')).toBeInTheDocument();
    expect(within(brand).getByRole('link', { name: 'Brand Refresh Campaign' }))
      .toHaveAttribute('href', '/projects/4?tab=budget');

    const portal = within(table).getByRole('row', { name: /Customer Portal Revamp/ });
    expect(within(portal).getByText('$160,300 left')).toBeInTheDocument();
    expect(within(portal).getByText('Spending 4.1 pts behind time')).toBeInTheDocument();
    expect(within(portal).queryByText('Over budget')).not.toBeInTheDocument();
  });
});
