import { useCallback, useMemo, useSyncExternalStore } from 'react';
import PropTypes from 'prop-types';
import { login } from '../services/apiClient';
import { changePassword, signOut } from '../services/authApi';
import { getSession, subscribe } from '../services/session';
import { canRole } from '../utils/permissions';
import { AuthContext } from './auth-context';

/**
 * Provides the signed-in user, their role, login, logout, changePassword and can(action).
 * The session store (services/session.js) is the source of truth, so a token refresh that
 * changes the role, or a refresh failure that signs the user out, updates the UI at once.
 *
 * @param {object} props Component props.
 * @param {React.ReactNode} props.children The app.
 * @returns {JSX.Element} The provider.
 */
export function AuthProvider({ children }) {
  const session = useSyncExternalStore(subscribe, getSession);
  const user = session?.user ?? null;
  const role = user?.role ?? null;
  const isAuthenticated = Boolean(session?.accessToken && user);

  const can = useCallback((action) => canRole(role, action), [role]);

  const value = useMemo(
    () => ({ user, role, isAuthenticated, login, logout: signOut, changePassword, can }),
    [user, role, isAuthenticated, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

AuthProvider.propTypes = {
  children: PropTypes.node.isRequired,
};
