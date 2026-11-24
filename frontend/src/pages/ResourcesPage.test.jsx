import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders from '../TestProviders';
import { request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';
import ResourcesPage from './ResourcesPage';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const person = (id, fullName, allocation, extra = {}) => ({
  id,
  full_name: fullName,
  email: `${fullName.split(' ')[0].toLowerCase()}@acme.test`,
  job_title: 'Engineer',
  department: 'Engineering',
  capacity_pct: 100,
  is_active: true,
  allocation_today_pct: allocation,
  ...extra,
});

const PEOPLE = [
  person(11, 'Aisha Khan', 120, { job_title: 'Senior Software Engineer' }),
  person(12, 'Ben Carter', 60, { job_title: 'Backend Engineer' }),
  person(13, 'Chloe Martin', 100, { department: 'Design' }),
  person(14, 'Old Timer', 0, { is_active: false }),
];

function listCalls() {
  return request.mock.calls.filter(([path, options = {}]) => (
    path === '/resources' && (options.method ?? 'GET') === 'GET' && options.query?.limit !== 100
  ));
}

function signInAs(role) {
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role } });
}

function renderPage(entry = '/resources') {
  return render(<TestProviders initialEntries={[entry]}><ResourcesPage /></TestProviders>);
}

const bar = (name) => screen.getByRole('progressbar', { name: `${name} allocation today` });

beforeEach(() => {
  clearSession();
  request.mockReset();
  request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
    if (method === 'GET') return { items: PEOPLE, total: PEOPLE.length, limit: 10, offset: 0 };
    if (method === 'DELETE') return null;
    return { id: 99, ...body };
  });
});

describe('ResourcesPage allocation bar', () => {
  it('switches to the warning style above 100%', async () => {
    signInAs('viewer');
    renderPage();
    await screen.findByRole('table', { name: 'Team members' });

    const over = bar('Aisha Khan');
    expect(over).toHaveAttribute('aria-valuetext', '120%, over-allocated');
    expect(over).toHaveAttribute('aria-valuenow', '100');
    expect(over.className).toMatch(/colorWarning/);
    expect(screen.getByText('120%, over-allocated')).toBeInTheDocument();

    const normal = bar('Ben Carter');
    expect(normal).toHaveAttribute('aria-valuetext', '60%');
    expect(normal.className).toMatch(/colorPrimary/);
    expect(normal.className).not.toMatch(/colorWarning/);
  });

  it('keeps exactly 100% in the normal style', async () => {
    signInAs('viewer');
    renderPage();
    await screen.findByRole('table', { name: 'Team members' });
    expect(bar('Chloe Martin')).toHaveAttribute('aria-valuetext', '100%');
    expect(bar('Chloe Martin').className).toMatch(/colorPrimary/);
  });

  it('shows the warning state on phone cards too', async () => {
    window.innerWidth = 375;
    signInAs('viewer');
    renderPage();
    const cards = await screen.findByRole('list', { name: 'Team members' });
    expect(within(cards).getByRole('progressbar', { name: 'Aisha Khan allocation today' }).className)
      .toMatch(/colorWarning/);
    expect(within(cards).getByText('120%, over-allocated')).toBeInTheDocument();
  });
});

describe('ResourcesPage', () => {
  it('shows name, job title, department and marks inactive people', async () => {
    signInAs('viewer');
    renderPage();
    const table = await screen.findByRole('table', { name: 'Team members' });
    const row = (name) => within(table).getAllByRole('row').find((r) => within(r).queryByText(name));
    expect(within(row('Aisha Khan')).getByText('Senior Software Engineer')).toBeInTheDocument();
    expect(within(row('Chloe Martin')).getByText('Design')).toBeInTheDocument();
    expect(within(row('Old Timer')).getByText('Inactive')).toBeInTheDocument();
    expect(within(row('Aisha Khan')).queryByText('Inactive')).not.toBeInTheDocument();
  });

  it.each([
    ['viewer', { create: false, edit: false, remove: false }],
    ['contributor', { create: true, edit: true, remove: false }],
    ['manager', { create: true, edit: true, remove: true }],
    ['admin', { create: true, edit: true, remove: true }],
  ])('%s sees only the controls their role allows', async (role, expected) => {
    signInAs(role);
    renderPage();
    await screen.findByRole('table', { name: 'Team members' });

    const present = (name) => screen.queryByRole('button', { name }) !== null;
    expect(present('Add person')).toBe(expected.create);
    expect(present('Edit Aisha Khan')).toBe(expected.edit);
    expect(present('Delete Aisha Khan')).toBe(expected.remove);
  });

  it('sends search, department and active filters to the API', async () => {
    signInAs('viewer');
    renderPage('/resources?q=eng&department=Design&is_active=false');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls().at(-1)[1].query).toEqual({
      q: 'eng', department: 'Design', is_active: 'false', limit: 10, offset: 0,
    });
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('Inactive');
  });

  it('offers the departments of people, not projects', async () => {
    signInAs('viewer');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Team members' });
    expect(request).toHaveBeenCalledWith('/resources', expect.objectContaining({ query: { limit: 100 } }));

    await user.click(screen.getByRole('combobox', { name: 'Department' }));
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(['All', 'Design', 'Engineering']);
  });

  it('creates a person with typed capacity and status', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table', { name: 'Team members' });

    await user.click(screen.getByRole('button', { name: 'Add person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add person' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Full name/ }), 'Dana Lee');
    await user.type(within(dialog).getByRole('textbox', { name: /^Email/ }), 'not-an-email');
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));
    expect(within(dialog).getByText('Email must be a valid email address')).toBeInTheDocument();

    await user.clear(within(dialog).getByRole('textbox', { name: /^Email/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /^Email/ }), 'dana@acme.test');
    await user.click(within(dialog).getByRole('button', { name: 'Add person' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/resources', {
      method: 'POST',
      body: { full_name: 'Dana Lee', email: 'dana@acme.test', capacity_pct: 100, is_active: true },
    }));
    expect(await screen.findByText('Person created')).toBeInTheDocument();
  });

  it('deactivates someone through the edit form with a real boolean', async () => {
    signInAs('contributor');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit Ben Carter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Ben Carter' });
    await user.click(within(dialog).getByRole('combobox', { name: /^Status/ }));
    await user.click(await screen.findByRole('option', { name: 'Inactive' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(request).toHaveBeenCalledWith('/resources/12', expect.objectContaining({
      method: 'PUT', body: expect.objectContaining({ is_active: false, capacity_pct: 100 }),
    })));
  });

  it('suggests deactivating before deleting', async () => {
    signInAs('manager');
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Delete Ben Carter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete person?' });
    expect(dialog).toHaveTextContent('their allocations removed and their deliverables unassigned');
    expect(dialog).toHaveTextContent('set their status to Inactive instead');
    await user.click(within(dialog).getByRole('button', { name: 'Delete person' }));
    expect(request).toHaveBeenCalledWith('/resources/12', { method: 'DELETE' });
  });
});
