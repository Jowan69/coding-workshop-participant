import PropTypes from 'prop-types';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/auth-context';
import NotAllowedPage from '../pages/NotAllowedPage';

/**
 * Only for signed-in users: others go to /login, which sends them back here afterwards.
 * With `action`, users whose role cannot perform it see a not-allowed page instead.
 *
 * @param {object} props Component props.
 * @param {'read'|'write'|'delete'|'manageUsers'} [props.action] Permission the route needs.
 * @param {React.ReactNode} [props.children] Content; nested routes render via Outlet otherwise.
 * @returns {JSX.Element} The content, a redirect or the not-allowed page.
 */
export default function ProtectedRoute({ action, children }) {
  const { isAuthenticated, can } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />;
  if (action && !can(action)) return <NotAllowedPage />;
  return children ?? <Outlet />;
}

ProtectedRoute.propTypes = {
  action: PropTypes.oneOf(['read', 'write', 'delete', 'manageUsers']),
  children: PropTypes.node,
};
