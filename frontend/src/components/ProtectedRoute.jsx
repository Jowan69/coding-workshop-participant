import PropTypes from 'prop-types';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/auth-context';
import NotAllowedPage from '../pages/NotAllowedPage';
import PageLoading from './PageLoading';

/**
 * Redirect, showing a loading state meanwhile. The target page is lazy-loaded and a redirect
 * is a transition, during which React keeps the current screen instead of a Suspense
 * fallback; without this the visitor would look at a blank page until the code arrives.
 */
function Redirect({ to, state }) {
  return (
    <>
      <Navigate to={to} replace state={state} />
      <PageLoading fullScreen />
    </>
  );
}

Redirect.propTypes = {
  to: PropTypes.string.isRequired,
  state: PropTypes.object,
};

/**
 * Only for signed-in users: others go to /login, which sends them back here afterwards. A
 * user whose password is temporary goes to /change-password until they replace it.
 * With `action`, users whose role cannot perform it see a not-allowed page instead.
 *
 * @param {object} props Component props.
 * @param {'read'|'write'|'delete'|'manageUsers'} [props.action] Permission the route needs.
 * @param {React.ReactNode} [props.children] Content; nested routes render via Outlet otherwise.
 * @returns {JSX.Element} The content, a redirect or the not-allowed page.
 */
export default function ProtectedRoute({ action, children }) {
  const { isAuthenticated, user, can } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Redirect to="/login" state={{ from: location }} />;
  if (user.must_change_password) return <Redirect to="/change-password" />;
  if (action && !can(action)) return <NotAllowedPage />;
  return children ?? <Outlet />;
}

ProtectedRoute.propTypes = {
  action: PropTypes.oneOf(['read', 'write', 'delete', 'manageUsers']),
  children: PropTypes.node,
};
