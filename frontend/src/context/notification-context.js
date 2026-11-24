import { createContext, useContext } from 'react';

/** Snackbar notifications: { notify(message, severity) }. Provided by NotificationProvider. */
export const NotificationContext = createContext(null);

/**
 * Show a short snackbar message.
 *
 * @returns {(message: string, severity?: 'success'|'info'|'warning'|'error') => void} notify.
 */
export function useNotify() {
  const value = useContext(NotificationContext);
  if (!value) throw new Error('useNotify must be used inside <NotificationProvider>');
  return value.notify;
}
