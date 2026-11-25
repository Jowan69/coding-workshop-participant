import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TestProviders from '../TestProviders';
import { ApiError } from '../services/apiClient';
import FormDialog from './FormDialog';

const FIELDS = [
  { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 10 },
  {
    name: 'kind',
    label: 'Kind',
    type: 'select',
    required: true,
    defaultValue: 'a',
    options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
  },
  { name: 'team', label: 'Team', type: 'autocomplete', freeSolo: true, options: ['Digital', 'Finance'] },
  {
    name: 'owner_id',
    label: 'Owner',
    type: 'autocomplete',
    options: [{ value: 7, label: 'Ola Owner' }, { value: 8, label: 'Ike Other' }],
  },
  { name: 'start', label: 'Start', type: 'date', required: true },
  {
    name: 'end',
    label: 'End',
    type: 'date',
    validate: (value, values) => (value < values.start ? 'End must be on or after Start' : null),
  },
  { name: 'amount', label: 'Amount', type: 'number', min: 0, decimals: 2 },
  { name: 'notes', label: 'Notes', type: 'text', multiline: true },
];

function renderDialog(props = {}) {
  const handlers = { onSubmit: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() };
  render(
    <TestProviders>
      <FormDialog open title="New thing" fields={FIELDS} {...handlers} {...props} />
    </TestProviders>,
  );
  return { ...handlers, ...props };
}

// Phase 6 (D2): onSubmit also receives the save context: one Idempotency-Key per opening
const SAVE_CONTEXT = { idempotencyKey: expect.any(String), handlesStale: false };

const field = (name) => screen.getByRole('textbox', { name: new RegExp(`^${name}`) });
const setDate = (label, value) => fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), {
  target: { value },
});

describe('FormDialog', () => {
  it('marks required fields and blocks submit until they are valid', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    expect(field('Name')).toBeRequired();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Start is required')).toBeInTheDocument();
    expect(field('Name')).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(field('Name'), 'Far too long a name');
    expect(screen.queryByText('Name is required')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Name must be at most 10 characters')).toBeInTheDocument();
  });

  it('runs number and cross-field rules', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    await user.type(field('Name'), 'Valid');
    setDate('Start', '2026-05-10');
    setDate('End', '2026-05-01');
    await user.type(screen.getByRole('spinbutton', { name: 'Amount' }), '1.234');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('End must be on or after Start')).toBeInTheDocument();
    expect(screen.getByText('Amount can have at most 2 decimal places')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits typed values, leaves untouched blanks out and closes', async () => {
    const user = userEvent.setup();
    const { onSubmit, onClose } = renderDialog();

    await user.type(field('Name'), '  Rocket ');
    await user.type(screen.getByRole('combobox', { name: 'Team' }), 'Space');
    await user.click(screen.getByRole('combobox', { name: 'Owner' }));
    await user.click(await screen.findByRole('option', { name: 'Ola Owner' }));
    setDate('Start', '2026-01-01');
    await user.type(screen.getByRole('spinbutton', { name: 'Amount' }), '12.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Rocket',
      kind: 'a',
      team: 'Space',
      owner_id: 7,
      start: '2026-01-01',
      amount: 12.5,
    }, SAVE_CONTEXT);
    expect(onClose).toHaveBeenCalled();
  });

  it('sends null for a field the user cleared when editing', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      initialValues: { name: 'Old', kind: 'b', start: '2026-01-01', notes: 'Remove me', amount: 3 },
    });

    expect(field('Name')).toHaveValue('Old');
    await user.clear(field('Notes'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Old', kind: 'b', start: '2026-01-01', amount: 3, notes: null,
    }, SAVE_CONTEXT);
  });

  it('shows server field errors on their fields and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new ApiError({
      status: 409,
      code: 'duplicate',
      message: 'A project with this name already exists',
      fieldErrors: { name: 'already exists' },
    }));
    const { onClose } = renderDialog({ onSubmit, initialValues: { name: 'Taken', start: '2026-01-01' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Name already exists')).toBeInTheDocument();
    expect(field('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows other server errors in an alert', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new ApiError({
      status: 0, code: 'network_error', message: 'Cannot reach the server.',
    }));
    renderDialog({ onSubmit, initialValues: { name: 'Fine', start: '2026-01-01' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server.');
  });

  it('disables the form while saving', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => new Promise(() => {}));
    renderDialog({ onSubmit, initialValues: { name: 'Fine', start: '2026-01-01' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(field('Name')).toBeDisabled();
  });

  it('sends select options with their own type and checks email and password rules', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <TestProviders>
        <FormDialog
          open
          title="Account"
          fields={[
            { name: 'email', label: 'Email', type: 'email', required: true },
            { name: 'password', label: 'Password', type: 'password', required: true, minLength: 8 },
            {
              name: 'is_active',
              label: 'Status',
              type: 'select',
              required: true,
              defaultValue: true,
              options: [{ value: true, label: 'Active' }, { value: false, label: 'Inactive' }],
            },
          ]}
          onSubmit={onSubmit}
          onClose={vi.fn()}
        />
      </TestProviders>,
    );

    await user.type(screen.getByRole('textbox', { name: /^Email/ }), 'nope');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Email must be a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /^Email/ }), '@acme.test');
    await user.type(screen.getByLabelText(/^Password/), ' pass ');
    await user.click(screen.getByRole('combobox', { name: /^Status/ }));
    await user.click(await screen.findByRole('option', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: 'nope@acme.test', password: 'short pass ', is_active: false,
    }, SAVE_CONTEXT);
  });

  it('is full screen on phones', () => {
    window.innerWidth = 375;
    renderDialog();
    expect(screen.getByRole('dialog').className).toMatch(/fullScreen/i);
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const SIMPLE = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'notes', label: 'Notes', type: 'text', multiline: true },
  { name: 'amount', label: 'Amount', type: 'number' },
];

/** A page around the dialog: it opens it, closes it when asked and can open it again. */
function Page(props) {
  const [open, setOpen] = useState(true);
  return (
    <TestProviders>
      <button type="button" onClick={() => setOpen(true)}>open again</button>
      <FormDialog open={open} title="Thing" fields={SIMPLE} onClose={() => setOpen(false)} {...props} />
    </TestProviders>
  );
}

const nameField = () => screen.getByRole('textbox', { name: /^Name/ });
nameField.hidden = () => screen.getByRole('textbox', { name: /^Name/, hidden: true });

describe('FormDialog saves once (phase 6, D1)', () => {
  it('sends one request when Save is clicked twice in the same tick', async () => {
    const gate = deferred();
    const onSubmit = vi.fn(() => gate.promise);
    render(<Page onSubmit={onSubmit} />);
    fireEvent.change(nameField(), { target: { value: 'Rocket' } });
    const save = screen.getByRole('button', { name: 'Save' });

    // Two native clicks in one batch: React has not re-rendered (disabled) between them.
    act(() => {
      save.click();
      save.click();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('stays disabled after a successful save while the dialog closes', async () => {
    const gate = deferred();
    const onSubmit = vi.fn(() => gate.promise);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} />);
    await user.type(nameField(), 'Rocket');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    gate.resolve();
    await waitFor(() => expect(screen.getByText('Fields marked * are required.')).not.toBeVisible());
    const closing = screen.getByRole('button', { name: /^(Save|Saving…)$/, hidden: true });
    expect(closing).toBeDisabled();
    act(() => closing.click());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('is enabled again after a failed save and the next time it opens', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new ApiError({ status: 500, code: 'internal_error', message: 'Server unavailable' }))
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} />);
    await user.type(nameField(), 'Rocket');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'open again' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
    expect(nameField()).toBeEnabled();
  });
});

describe('FormDialog idempotency key (phase 6, D2)', () => {
  const keyOf = (call) => call[1].idempotencyKey;

  it('reuses one key across retries of the same opening and makes a new one per opening', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'network_error', message: 'Cannot reach the server' }))
      .mockRejectedValueOnce(new ApiError({ status: 0, code: 'timeout', message: 'Too slow' }))
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} />);
    await user.type(nameField(), 'Rocket');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Too slow')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const [first, second, third] = onSubmit.mock.calls.map(keyOf);
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(second).toBe(first);
    expect(third).toBe(first);

    await user.click(screen.getByRole('button', { name: 'open again' }));
    await user.type(await screen.findByRole('textbox', { name: /^Name/ }), 'Shuttle');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(4));
    expect(keyOf(onSubmit.mock.calls[3])).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(keyOf(onSubmit.mock.calls[3])).not.toBe(first);
  });
});

describe('FormDialog editing (phase 6, D3)', () => {
  const RECORD = { id: 5, name: 'Old name', notes: 'Old notes', amount: 3, updated_at: '2026-11-24T10:00:00.123456+00:00' };
  const FRESH = { ...RECORD, name: 'Their name', notes: 'Their notes', updated_at: '2026-11-24T11:30:00.654321+00:00' };
  const stale = () => new ApiError({
    status: 409, code: 'stale_record', message: 'This thing was changed by someone else after you loaded it.',
  });

  it('sends only the fields the user changed, with expected_updated_at', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} initialValues={RECORD} changesOnly />);
    await user.clear(screen.getByRole('textbox', { name: /^Notes/ }));
    await user.type(nameField(), ' 2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'Old name 2', notes: null, expected_updated_at: RECORD.updated_at,
    });
  });

  it('closes without a request when nothing was changed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} initialValues={RECORD} changesOnly />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still sends every field when creating', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} initialValues={{ notes: 'Default notes' }} />);
    await user.type(nameField(), 'New');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ name: 'New', notes: 'Default notes' });
  });

  it('says the record was changed by someone else and reloads it into the form', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(stale()).mockResolvedValue(undefined);
    const onReload = vi.fn().mockResolvedValue(FRESH);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} onReload={onReload} initialValues={RECORD} changesOnly />);
    await user.type(nameField(), ' mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This was changed by someone else');
    expect(onSubmit.mock.calls[0][1].handlesStale).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(nameField()).toHaveValue('Old name mine');

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(nameField()).toHaveValue('Their name'));
    expect(screen.getByRole('textbox', { name: /^Notes/ })).toHaveValue('Their notes');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onReload).toHaveBeenCalledTimes(1);

    // The next save is judged against the reloaded copy.
    await user.type(nameField(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1][0]).toEqual({ name: 'Their name!', expected_updated_at: FRESH.updated_at });
  });

  it('says why a reload failed and lets the user try again', async () => {
    const onSubmit = vi.fn().mockRejectedValue(stale());
    const onReload = vi.fn()
      .mockRejectedValueOnce(new ApiError({ status: 404, code: 'not_found', message: 'Thing 5 not found' }))
      .mockResolvedValueOnce(FRESH);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} onReload={onReload} initialValues={RECORD} changesOnly />);
    await user.type(nameField(), ' mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Thing 5 not found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(nameField()).toHaveValue('Their name'));
  });

  it('shows a stale error as an ordinary message when the page gives no way to reload', async () => {
    const onSubmit = vi.fn().mockRejectedValue(stale());
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} initialValues={RECORD} changesOnly />);
    await user.type(nameField(), ' mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This thing was changed by someone else after you loaded it.')).toBeInTheDocument();
    expect(onSubmit.mock.calls[0][1].handlesStale).toBe(false);
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });
});

describe('FormDialog date limits (phase 6, E6)', () => {
  const DATED = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'start', label: 'Start', type: 'date', required: true },
  ];

  it('gives date inputs the API\'s first and last day', () => {
    render(<Page onSubmit={vi.fn()} fields={DATED} />);
    const input = screen.getByLabelText(/^Start/);
    expect(input).toHaveAttribute('min', '2000-01-01');
    expect(input).toHaveAttribute('max', '2100-12-31');
  });

  it.each(['1999-12-31', '2101-01-01'])('refuses %s before asking the API', async (day) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} fields={DATED} />);
    await user.type(nameField(), 'Rocket');
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: day } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Start must be between Jan 1, 2000 and Dec 31, 2100')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['2000-01-01', '2100-12-31'])('accepts %s', async (day) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} fields={DATED} />);
    await user.type(nameField(), 'Rocket');
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: day } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ name: 'Rocket', start: day });
  });
});

describe('FormDialog unsaved edits (phase 6, F1)', () => {
  const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });

  it.each([
    ['Cancel', (user) => user.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Esc', (user) => user.keyboard('{Escape}')],
    ['a click outside', () => fireEvent.click(document.querySelector('.MuiBackdrop-root'))],
  ])('asks before closing a changed form by %s', async (_name, close) => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} />);
    await user.type(nameField(), 'Half typed');

    await close(user);

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(prompt).toHaveTextContent('What you changed in this form has not been saved.');
    // the form is still there, behind the question (and hidden from assistive technology)
    expect(screen.getByRole('dialog', { name: 'Thing', hidden: true })).toBeInTheDocument();
    expect(nameField.hidden()).toHaveValue('Half typed');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the form and what was typed when the user chooses to keep editing', async () => {
    const user = userEvent.setup();
    render(<Page onSubmit={vi.fn()} />);
    await user.type(nameField(), 'Half typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(discardPrompt()).not.toBeInTheDocument());
    expect(nameField()).toHaveValue('Half typed');
  });

  it('closes and forgets the edits when the user discards them', async () => {
    const user = userEvent.setup();
    render(<Page onSubmit={vi.fn()} />);
    await user.type(nameField(), 'Half typed');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'open again' }));
    expect(await screen.findByRole('textbox', { name: /^Name/ })).toHaveValue('');
    expect(discardPrompt()).not.toBeInTheDocument();
  });

  it.each([
    ['Cancel', (user) => user.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Esc', (user) => user.keyboard('{Escape}')],
    ['a click outside', () => fireEvent.click(document.querySelector('.MuiBackdrop-root'))],
  ])('closes an untouched form at once by %s', async (_name, close) => {
    const user = userEvent.setup();
    render(<Page onSubmit={vi.fn()} initialValues={{ name: 'Existing', notes: 'Kept' }} />);
    await close(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('counts a change that was typed and undone as untouched', async () => {
    const user = userEvent.setup();
    render(<Page onSubmit={vi.fn()} initialValues={{ name: 'Existing' }} />);
    await user.type(nameField(), 'x');
    await user.type(nameField(), '{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('does not ask after a successful save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Page onSubmit={onSubmit} />);
    await user.type(nameField(), 'Saved');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('FormDialog opens on its first field (phase 6, F9)', () => {
  it('focuses a text field', async () => {
    render(<Page onSubmit={vi.fn()} />);
    await waitFor(() => expect(nameField()).toHaveFocus());
  });

  it('focuses a picker when that comes first', async () => {
    const fields = [
      { name: 'owner_id', label: 'Person', type: 'autocomplete', required: true, options: [{ value: 7, label: 'Ola' }] },
      { name: 'name', label: 'Name', type: 'text' },
    ];
    render(<Page onSubmit={vi.fn()} fields={fields} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /^Person/ })).toHaveFocus());
  });

  it('focuses the first field again each time it opens', async () => {
    const user = userEvent.setup();
    render(<Page onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'open again' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveFocus());
  });

  it('limits a password input to its maximum length', () => {
    const fields = [{ name: 'password', label: 'Password', type: 'password', required: true, maxLength: 128 }];
    render(<Page onSubmit={vi.fn()} fields={fields} />);
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('maxlength', '128');
  });
});
