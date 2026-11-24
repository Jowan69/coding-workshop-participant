import PropTypes from 'prop-types';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { AuthProvider } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import theme from './theme';

/**
 * Test-only: the app's providers around a component, with an in-memory router.
 * Set the signed-in user with services/session.setSession before rendering.
 *
 * @param {object} props Component props.
 * @param {React.ReactNode} props.children Component under test.
 * @param {Array<string|object>} [props.initialEntries] Router history.
 * @returns {JSX.Element} The wrapped component.
 */
export default function TestProviders({ children, initialEntries = ['/'] }) {
  return (
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={initialEntries}>
        <NotificationProvider>
          <AuthProvider>{children}</AuthProvider>
        </NotificationProvider>
      </MemoryRouter>
    </ThemeProvider>
  );
}

TestProviders.propTypes = {
  children: PropTypes.node.isRequired,
  initialEntries: PropTypes.array,
};

/**
 * Test-only: prints the current route so a test can assert on navigation.
 *
 * @returns {JSX.Element} The pathname and search string.
 */
export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}
