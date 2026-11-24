import { HashRouter, Route, Routes } from 'react-router-dom';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import AppLayout from './components/AppLayout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';
import PlaceholderPage from './pages/PlaceholderPage';
import ProjectsPage from './pages/ProjectsPage';
import theme from './theme';

/**
 * Every route. /login is public; the rest need a signed-in user, and /users needs an admin.
 *
 * @returns {JSX.Element} The route table.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route
          index
          element={(
            <PlaceholderPage
              title="Dashboard"
              description="Portfolio health, deadline risk and budget at a glance."
            />
          )}
        />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<PlaceholderPage title="Project details" />} />
        <Route
          path="resources"
          element={<PlaceholderPage title="Resources" description="People, capacity and allocations." />}
        />
        <Route
          path="users"
          element={(
            <ProtectedRoute action="manageUsers">
              <PlaceholderPage title="Users" description="Accounts and roles." />
            </ProtectedRoute>
          )}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/**
 * The app: theme, hash routing (CloudFront has no SPA fallback), snackbars and auth.
 *
 * @returns {JSX.Element} The app.
 */
export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <HashRouter>
        <NotificationProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </NotificationProvider>
      </HashRouter>
    </ThemeProvider>
  );
}
