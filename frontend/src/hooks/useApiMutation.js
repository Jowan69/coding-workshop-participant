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
 * Each mutation takes an optional last argument that replaces the default success message,
 * e.g. `update(id, { role }, 'Pat is now a Manager')`.
 *
 * @returns {{create: (body: object, message?: string) => Promise<object>,
 *   update: (id: number, body: object, message?: string) => Promise<object>,
 *   remove: (id: number, message?: string) => Promise<null>, saving: boolean}} Mutations and a
 *   busy flag.
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
    (body, message) => run(
      () => request(basePath, { method: 'POST', body }),
      message ?? `${label} created`,
    ),
    [run, basePath, label],
  );
  const update = useCallback(
    (id, body, message) => run(
      () => request(`${basePath}/${id}`, { method: 'PUT', body }),
      message ?? `${label} updated`,
    ),
    [run, basePath, label],
  );
  const remove = useCallback(
    (id, message) => run(
      () => request(`${basePath}/${id}`, { method: 'DELETE' }),
      message ?? `${label} deleted`,
    ),
    [run, basePath, label],
  );

  return useMemo(
    () => ({ create, update, remove, saving: pending > 0 }),
    [create, update, remove, pending],
  );
}
