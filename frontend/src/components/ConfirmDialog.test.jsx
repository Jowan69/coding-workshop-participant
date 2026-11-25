import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TestProviders from '../TestProviders';
import ConfirmDialog from './ConfirmDialog';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A page that opens the dialog and closes it when asked, like the real pages do. */
function Harness({ onConfirm }) {
  const [open, setOpen] = useState(true);
  return (
    <TestProviders>
      <button type="button" onClick={() => setOpen(true)}>open again</button>
      <ConfirmDialog
        open={open}
        title="Delete project?"
        message="It will be permanently deleted."
        confirmLabel="Delete project"
        destructive
        onConfirm={onConfirm}
        onClose={() => setOpen(false)}
      />
    </TestProviders>
  );
}

describe('ConfirmDialog', () => {
  it('runs the action once when the confirm button is clicked twice in the same tick', async () => {
    const gate = deferred();
    const onConfirm = vi.fn(() => gate.promise);
    render(<Harness onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: 'Delete project' });

    // Two native clicks in one batch: React has not re-rendered (disabled) between them.
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps both buttons disabled from the first click until the dialog has closed', async () => {
    const gate = deferred();
    const onConfirm = vi.fn(() => gate.promise);
    const user = userEvent.setup();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    gate.resolve();
    // The action succeeded and the dialog is fading out: the button must not come back to life.
    await waitFor(() => expect(screen.getByText('It will be permanently deleted.')).not.toBeVisible());
    const closing = screen.getByRole('button', { name: /Delete project|Working…/, hidden: true });
    expect(closing).toBeDisabled();
    act(() => closing.click());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('enables the buttons again when the action fails, so it can be retried', async () => {
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    const retry = await screen.findByRole('button', { name: 'Delete project' });
    expect(retry).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'Delete project?' })).toBeInTheDocument();

    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('is enabled again the next time it opens', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'open again' }));
    const confirm = await screen.findByRole('button', { name: 'Delete project' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
  });
});
