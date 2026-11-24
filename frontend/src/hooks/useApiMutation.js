import { useCallback, useMemo, useState } from 'react';
import { useNotify } from '../context/notification-context';
import { request } from '../services/apiClient';

function failureMessage(error) {
  const message = error?.message || 'Something went wrong. Please try again.';
  const hasFieldErrors = error?.fieldErrors && Object.keys(error.fieldErrors).length > 0;
  return hasFieldErrors ? `${message}. Check the highlighted fields.` : message;
}

/**
 * Create, update and delete records of one API collection, with snackbars for the outcome.
 * Failures are re-thrown so a form can map `error.fieldErrors` onto its fields.
 *
 * @param {string} basePath Collection path, e.g. "/projects".
 * @param {object} [options] Options.
 * @param {string} [options.label] Singular noun for messages, e.g. "Project".
 * @returns {{create: (body: object) => Promise<object>,
 *   update: (id: number, body: object) => Promise<object>,
 *   remove: (id: number) => Promise<null>, saving: boolean}} Mutations and a busy flag.
 */
export function useApiMutation(basePath, { label = 'Record' } = {}) {
  const notify = useNotify();
  const [pending, setPending] = useState(0);

  const run = useCallback(async (send, successMessage) => {
    setPending((count) => count + 1);
    try {
      const result = await send();
      notify(successMessage, 'success');
      return result;
    } catch (error) {
      notify(failureMessage(error), 'error');
      throw error;
    } finally {
      setPending((count) => count - 1);
    }
  }, [notify]);

  const create = useCallback(
    (body) => run(() => request(basePath, { method: 'POST', body }), `${label} created`),
    [run, basePath, label],
  );
  const update = useCallback(
    (id, body) => run(
      () => request(`${basePath}/${id}`, { method: 'PUT', body }),
      `${label} updated`,
    ),
    [run, basePath, label],
  );
  const remove = useCallback(
    (id) => run(() => request(`${basePath}/${id}`, { method: 'DELETE' }), `${label} deleted`),
    [run, basePath, label],
  );

  return useMemo(
    () => ({ create, update, remove, saving: pending > 0 }),
    [create, update, remove, pending],
  );
}
