import { fireEvent, render, screen } from '@testing-library/react';
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
    });
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
    });
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
    });
  });

  it('is full screen on phones', () => {
    window.innerWidth = 375;
    renderDialog();
    expect(screen.getByRole('dialog').className).toMatch(/fullScreen/i);
  });
});
