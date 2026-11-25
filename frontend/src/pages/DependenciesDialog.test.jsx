import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TestProviders from '../TestProviders';
import { ApiError, request } from '../services/apiClient';
import { clearSession, setSession } from '../services/session';
import DependenciesDialog from './DependenciesDialog';

vi.mock('../services/apiClient', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

const item = (id, title, status, dueDate) => ({ id, project_id: 1, title, status, due_date: dueDate });
const CONTRACT = item(101, 'API contract', 'done', '2026-01-10');
const PAYMENTS = item(102, 'Payments integration', 'blocked', '2026-02-01');
const SECURITY = item(103, 'Security review', 'not_started', '2026-03-01');
const STORE = item(104, 'App store submission', 'not_started', '2026-04-01');
const PUSH = item(105, 'Push notifications', 'in_progress', '2026-05-01');

const CYCLE_MESSAGE = 'Deliverable 104 already depends on 103 (directly or through others), so this link would create a cycle';

function useApi({ addFails = false } = {}) {
  let dependsOn = [PAYMENTS];
  request.mockImplementation(async (path, { method = 'GET', body } = {}) => {
    if (method === 'GET' && path === '/deliverables/103/dependencies') {
      return { items: dependsOn, total: dependsOn.length, limit: dependsOn.length, offset: 0, dependents: [STORE] };
    }
    if (method === 'GET' && path === '/deliverables') {
      return { items: [CONTRACT, PAYMENTS, SECURITY, STORE, PUSH], total: 5, limit: 100, offset: 0 };
    }
    if (method === 'POST' && path === '/deliverables/103/dependencies') {
      if (addFails) {
        throw new ApiError({
          status: 400,
          code: 'validation_error',
          message: CYCLE_MESSAGE,
          fieldErrors: { depends_on_id: CYCLE_MESSAGE },
        });
      }
      const added = [CONTRACT, PUSH].find((d) => d.id === body.depends_on_id);
      dependsOn = [...dependsOn, added];
      return { deliverable_id: 103, depends_on: added };
    }
    if (method === 'DELETE') {
      dependsOn = dependsOn.filter((d) => !path.endsWith(`/${d.id}`));
      return null;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
}

function calls(method, path) {
  return request.mock.calls.filter(([url, options = {}]) => (
    url === path && (options.method ?? 'GET') === method
  ));
}

function renderDialog(role) {
  setSession({ accessToken: 't', refreshToken: 'r', user: { id: 1, full_name: 'Pat', role } });
  return render(
    <TestProviders>
      <DependenciesDialog open deliverable={SECURITY} onClose={vi.fn()} />
    </TestProviders>,
  );
}

const section = (name) => screen.getByRole('region', { name });

beforeEach(() => {
  clearSession();
  request.mockReset();
  useApi();
});

describe('DependenciesDialog', () => {
  it('shows what the deliverable depends on and what depends on it', async () => {
    renderDialog('viewer');
    expect(screen.getByRole('dialog', { name: 'Dependencies: Security review' })).toBeInTheDocument();

    await screen.findByRole('region', { name: 'Depends on' });
    expect(within(section('Depends on')).getByText('Payments integration')).toBeInTheDocument();
    expect(within(section('Depends on')).getByText('Blocked')).toBeInTheDocument();
    expect(within(section('Needed by')).getByText('App store submission')).toBeInTheDocument();
  });

  it('lets viewers look but not change anything', async () => {
    renderDialog('viewer');
    await screen.findByRole('region', { name: 'Depends on' });
    expect(screen.queryByRole('combobox', { name: 'Depends on' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove dependency on Payments integration' })).not.toBeInTheDocument();
    expect(calls('GET', '/deliverables')).toHaveLength(0);
  });

  it('offers only other deliverables of the same project that are not linked yet', async () => {
    renderDialog('contributor');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Depends on' }));

    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(options).toEqual(['API contract', 'App store submission', 'Push notifications']);
    expect(calls('GET', '/deliverables')[0][1].query).toEqual({ project_id: 1, sort: 'title', limit: 100 });
  });

  it('shows the API reason when a link is rejected', async () => {
    useApi({ addFails: true });
    renderDialog('contributor');
    const user = userEvent.setup();
    const picker = await screen.findByRole('combobox', { name: 'Depends on' });

    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'App store submission' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    const dialog = screen.getByRole('dialog', { name: 'Dependencies: Security review' });
    expect(await within(dialog).findByText(CYCLE_MESSAGE)).toBeInTheDocument();
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(picker).toHaveAccessibleDescription(CYCLE_MESSAGE);
    expect(request).toHaveBeenCalledWith('/deliverables/103/dependencies', {
      method: 'POST', body: { depends_on_id: 104 },
    });
    expect(within(section('Depends on')).queryByText('App store submission')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('asks for a choice before adding', async () => {
    renderDialog('contributor');
    const user = userEvent.setup();
    await screen.findByRole('combobox', { name: 'Depends on' });
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Choose a deliverable to link')).toBeInTheDocument();
    expect(calls('POST', '/deliverables/103/dependencies')).toHaveLength(0);
  });

  it('adds a link and shows it', async () => {
    renderDialog('contributor');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Depends on' }));
    await user.click(await screen.findByRole('option', { name: 'Push notifications' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await within(section('Depends on')).findByText('Push notifications')).toBeInTheDocument();
    expect(screen.getByText('"Security review" now depends on "Push notifications"')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Depends on' })).toHaveValue('');
  });

  it('lets managers remove a link', async () => {
    renderDialog('manager');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove dependency on Payments integration' }));

    expect(request).toHaveBeenCalledWith('/deliverables/103/dependencies/102', { method: 'DELETE' });
    expect(await screen.findByText('Does not depend on anything.')).toBeInTheDocument();
  });

  // Phase 6 (F2): unlinking edits a deliverable and deletes no record, so contributors may.
  it('lets contributors remove a link too', async () => {
    renderDialog('contributor');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove dependency on Payments integration' }));
    await waitFor(() => expect(calls('DELETE', '/deliverables/103/dependencies/102')).toHaveLength(1));
    expect(await screen.findByText('Does not depend on anything.')).toBeInTheDocument();
  });

  it('does not offer removal to viewers', async () => {
    renderDialog('viewer');
    await screen.findByRole('region', { name: 'Depends on' });
    expect(screen.queryByRole('button', { name: 'Remove dependency on Payments integration' })).not.toBeInTheDocument();
  });

  it('shows a load failure with a retry', async () => {
    request.mockRejectedValueOnce(new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server.' }));
    renderDialog('viewer');
    const user = userEvent.setup();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the dependencies. Cannot reach the server.');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(section('Needed by')).getByText('App store submission')).toBeInTheDocument());
  });
});
