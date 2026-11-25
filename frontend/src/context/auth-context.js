import { createContext, useContext } from 'react';

/** Auth state: { user, role, isAuthenticated, login, logout, changePassword, can }. */
export const AuthContext = createContext(null);

/**
 * The current user, their role and the permission check.
 *
 * @returns {{user: object|null, role: string|null, isAuthenticated: boolean,
 *   login: (email: string, password: string) => Promise<object>,
 *   logout: () => Promise<void>,
 *   changePassword: (current: string, next: string) => Promise<object>,
 *   can: (action: 'read'|'write'|'delete'|'manageUsers') => boolean}} Auth state.
 */
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
