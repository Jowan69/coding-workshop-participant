import { useCallback, useMemo, useState } from 'react';
import { useNotify } from '../context/notification-context';
import { request } from '../services/apiClient';
import { STALE_MESSAGE } from '../utils/staleness';

function failureMessage(error) {
  const message = error?.message || 'Something went wrong. Please try again.';
  const hasFieldErrors = error?.fieldErrors && Object.keys(error.fieldErrors).length > 0;
  return hasFieldErrors ? `${message}. Check the highlighted fields.` : message;
}

/**
 * Create, update and delete records of one API collection, with snackbars for the outcome.
 * Failures are re-thrown so a form can map `error.fieldErrors` onto its fields.
 *
 * A 409 stale_record (someone else changed the record first) is reported as "This was changed
 * by someone else", with a Reload button when `onStale` is given. A caller that shows that
 * itself (FormDialog with `onReload`) passes `handlesStale` in the call's context.
 *
 * @param {string} basePath Collection path, e.g. "/projects".
 * @param {object} [options] Options.
 * @param {string} [options.label] Singular noun for messages, e.g. "Project".
 * @param {() => void} [options.onStale] Reloads what is on screen after a stale update.
 * Each mutation takes an optional message that replaces the default success message, e.g.
 * `update(id, { role }, 'Pat is now a Manager')`, and an optional context: FormDialog's second
 * `onSubmit` argument (`idempotencyKey`, `handlesStale`).
 *
 * @returns {{create: (body: object, message?: string, context?: object) => Promise<object>,
 *   update: (id: number, body: object, message?: string, context?: object) => Promise<object>,
 *   remove: (id: number, message?: string) => Promise<null>,
 *   fetchOne: (id: number) => Promise<object>, saving: boolean}} Mutations, a fresh read of
 *   one record and a busy flag.
 */
export function useApiMutation(basePath, { label = 'Record', onStale } = {}) {
  const notify = useNotify();
  const [pending, setPending] = useState(0);

  const run = useCallback(async (send, successMessage, { handlesStale = false } = {}) => {
    setPending((count) => count + 1);
    try {
      const result = await send();
      notify(successMessage, 'success');
      return result;
    } catch (error) {
      if (error?.code !== 'stale_record') {
        notify(failureMessage(error), 'error');
      } else if (!handlesStale) {
        const action = onStale ? { label: 'Reload', onClick: onStale } : undefined;
        notify(STALE_MESSAGE, 'warning', { action });
      }
      throw error;
    } finally {
      setPending((count) => count - 1);
    }
  }, [notify, onStale]);

  const create = useCallback(
    (body, message, context = {}) => run(
      () => request(basePath, {
        method: 'POST',
        body,
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      }),
      message ?? `${label} created`,
      context,
    ),
    [run, basePath, label],
  );
  const update = useCallback(
    (id, body, message, context = {}) => run(
      () => request(`${basePath}/${id}`, { method: 'PUT', body }),
      message ?? `${label} updated`,
      context,
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
  const fetchOne = useCallback((id) => request(`${basePath}/${id}`), [basePath]);

  return useMemo(
    () => ({ create, update, remove, fetchOne, saving: pending > 0 }),
    [create, update, remove, fetchOne, pending],
  );
}
