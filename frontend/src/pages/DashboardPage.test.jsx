import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders, { LocationProbe } from '../TestProviders';
import { ApiError, request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';
import DashboardPage, { AUTO_REFRESH_MS } from './DashboardPage';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const AS_OF = '2026-11-24';
const SUMMARY = {
  as_of: AS_OF,
  active_projects: 4,
  at_risk_projects: 3,
  overdue_deliverables: 4,
  over_allocated_people: 2,
  over_budget_projects: 0,
};

const QUESTIONS = [
  'What is the status of each active project?',
  'Which projects are at risk?',
  'Who is allocated to which project?',
  'How are deliverables progressing?',
  'Who is over-allocated?',
  'What is holding up each deliverable?',
  'Are projects within budget?',
];

const STATUS_ITEM = {
  id: 2, name: 'Data Center Migration', department: 'Operations', status: 'active',
  start_date: '2026-06-27', end_date: '2026-11-14', days_to_deadline: -10, deliverables_total: 4,
  deliverables_done: 2, percent_done: 50, time_elapsed_pct: 100, health: 'overdue',
};

const ROUTES = {
  '/insights/summary': () => SUMMARY,
  '/insights/project-status': () => ({ as_of: AS_OF, items: [STATUS_ITEM] }),
  '/insights/at-risk': () => ({
    as_of: AS_OF,
    items: [{
      ...STATUS_ITEM,
      forecast_end_date: null,
      reasons: [{ code: 'deadline_passed', message: 'Deadline passed 10 days ago' }],
    }],
  }),
  '/insights/allocation': () => ({ on: AS_OF, projects: [], resources: [] }),
  '/insights/deliverables': () => ({ as_of: AS_OF, items: [] }),
  '/insights/over-allocated': () => ({ from: AS_OF, to: '2027-02-22', items: [] }),
  '/insights/dependencies': () => ({ project_id: 2, project_name: 'Data Center Migration', items: [], longest_chain: [] }),
  '/insights/budget': () => ({ as_of: AS_OF, items: [] }),
  '/projects': () => ({ items: [{ id: 2, name: 'Data Center Migration' }], total: 1, limit: 100, offset: 0 }),
};

const serverError = () => {
  throw new ApiError({ status: 500, code: 'internal_error', message: 'Server unavailable' });
};

function useRoutes(overrides = {}) {
  const routes = { ...ROUTES, ...overrides };
  request.mockImplementation(async (path, options = {}) => routes[path](options));
}

function renderDashboard() {
  render(
    <TestProviders>
      <DashboardPage />
      <LocationProbe />
    </TestProviders>,
  );
}

/** A tile's accessible name: its count, then its label. */
const tileName = (count, label) => new RegExp(`^${count}\\s*${label}$`);

async function tiles() {
  const region = await screen.findByRole('region', { name: 'Headline counts' });
  await waitFor(() => expect(within(region).queryAllByTestId('tile-loading')).toHaveLength(0));
  return region;
}

beforeEach(() => {
  clearSession();
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role: 'viewer' } });
  request.mockReset();
});

describe('DashboardPage', () => {
  it('asks the seven questions in order, under one page title', async () => {
    useRoutes();
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(QUESTIONS);
    expect(await screen.findByText('Deadline passed 10 days ago')).toBeInTheDocument();
  });

  it('shows the five headline counts', async () => {
    useRoutes();
    renderDashboard();
    const region = await tiles();
    const counts = [...within(region).getAllByRole('link'), ...within(region).getAllByRole('button')]
      .map((tile) => tile.textContent);
    expect(counts).toEqual([
      '4Active projects', '3Projects at risk', '4Overdue deliverables', '2Over-allocated people',
      '0Projects over budget',
    ]);
  });

  it('opens the Projects list filtered to active projects', async () => {
    const user = userEvent.setup();
    useRoutes();
    renderDashboard();
    const region = await tiles();
    const active = within(region).getByRole('link', { name: tileName(4, 'Active projects') });
    expect(active).toHaveAttribute('href', '/projects?status=active');
    await user.click(active);
    expect(screen.getByTestId('location')).toHaveTextContent('/projects?status=active');
  });

  it.each([
    [3, 'Projects at risk', 'Which projects are at risk?'],
    [4, 'Overdue deliverables', 'How are deliverables progressing?'],
    [2, 'Over-allocated people', 'Who is over-allocated?'],
    [0, 'Projects over budget', 'Are projects within budget?'],
  ])('jumps from the %s "%s" tile to its section', async (count, label, question) => {
    const user = userEvent.setup();
    useRoutes();
    renderDashboard();
    const region = await tiles();
    await user.click(within(region).getByRole('button', { name: tileName(count, label) }));
    expect(screen.getByRole('heading', { level: 2, name: question })).toHaveFocus();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('keeps every other section working when one fails', async () => {
    useRoutes({ '/insights/at-risk': serverError, '/insights/summary': serverError });
    renderDashboard();
    expect(await screen.findByText('Could not load at-risk projects')).toBeInTheDocument();
    expect(await screen.findByText('Could not load the headline counts')).toBeInTheDocument();
    const status = screen.getByRole('region', { name: 'What is the status of each active project?' });
    expect(await within(status).findByText('Data Center Migration')).toBeInTheDocument();
    const budget = screen.getByRole('region', { name: 'Are projects within budget?' });
    expect(await within(budget).findByText('No projects yet, so no budgets to compare.')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('retries the headline counts on their own', async () => {
    const user = userEvent.setup();
    let failing = true;
    useRoutes({ '/insights/summary': () => (failing ? serverError() : SUMMARY) });
    renderDashboard();
    const alert = await screen.findByRole('alert');
    failing = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    const region = await tiles();
    expect(within(region).getByRole('link', { name: tileName(4, 'Active projects') })).toBeInTheDocument();
  });

  it('stacks the sections as cards on a phone', async () => {
    window.innerWidth = 375;
    useRoutes();
    renderDashboard();
    await tiles();
    const status = screen.getByRole('region', { name: 'What is the status of each active project?' });
    const cards = await within(status).findByRole('list', { name: 'Project status' });
    expect(within(cards).getByRole('link', { name: 'Data Center Migration' })).toBeInTheDocument();
    expect(within(status).queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Dashboard freshness', () => {
  const INSIGHTS = Object.keys(ROUTES).filter((path) => path.startsWith('/insights/'));
  const callsTo = (path) => request.mock.calls.filter(([url]) => url === path).length;
  const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  };

  afterEach(() => {
    vi.useRealTimers();
    delete document.visibilityState;
  });

  it('says when the data last arrived', async () => {
    useRoutes();
    renderDashboard();
    expect(screen.getByTestId('dashboard-updated')).toHaveTextContent('Loading…');
    await tiles();
    expect(screen.getByTestId('dashboard-updated')).toHaveTextContent(/^Updated \d{2}:\d{2}$/);
  });

  it('reloads every section when Refresh is clicked, keeping the answers on screen', async () => {
    const user = userEvent.setup();
    useRoutes();
    renderDashboard();
    await tiles();
    expect(await screen.findByText('Deadline passed 10 days ago')).toBeInTheDocument();
    INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(1));

    // Hold the second round open: the first answers must stay, with no skeletons.
    const release = {};
    const hold = (name) => () => new Promise((resolve) => { release[name] = resolve; });
    useRoutes({ '/insights/at-risk': hold('atRisk'), '/insights/summary': hold('summary') });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(2)));
    expect(screen.getByText('Deadline passed 10 days ago')).toBeInTheDocument();
    expect(screen.queryByTestId('tile-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-loading')).not.toBeInTheDocument();

    await act(async () => {
      release.summary({ ...SUMMARY, active_projects: 9 });
      release.atRisk({ as_of: AS_OF, items: [] });
    });
    const region = await tiles();
    expect(await within(region).findByRole('link', { name: tileName(9, 'Active projects') })).toBeInTheDocument();
    expect(await screen.findByText('No project is at risk: every open project is on track.')).toBeInTheDocument();
  });

  it('reloads by itself every 60 seconds while the tab is visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setVisibility('visible');
    useRoutes();
    renderDashboard();
    await tiles();
    expect(AUTO_REFRESH_MS).toBe(60000);

    act(() => { vi.advanceTimersByTime(AUTO_REFRESH_MS - 1); });
    INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(1));
    act(() => { vi.advanceTimersByTime(1); });
    await waitFor(() => INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(2)));
  });

  it('does not reload while the tab is hidden, and catches up when it is shown again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    setVisibility('visible');
    useRoutes();
    renderDashboard();
    await tiles();

    setVisibility('hidden');
    act(() => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 3); });
    INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(1));

    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(2)));
  });

  it('stops the timer when the page is left', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setVisibility('visible');
    useRoutes();
    const view = render(<TestProviders><DashboardPage /></TestProviders>);
    await tiles();
    view.unmount();
    act(() => { vi.advanceTimersByTime(AUTO_REFRESH_MS * 2); });
    INSIGHTS.forEach((path) => expect(callsTo(path)).toBe(1));
  });
});
