import { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import AppLayout from './components/AppLayout';
import PageLoading from './components/PageLoading';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import theme from './theme';

// Each page is its own chunk, fetched when its route is first opened, so the first load
// carries the shell and one page instead of the whole app.
const ChangePasswordPage = lazy(() => import('./pages/ChangePasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ResourcesPage = lazy(() => import('./pages/ResourcesPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));

/**
 * Every route. /login is public; /change-password is for a signed-in user with a temporary
 * password; the rest need a signed-in user, and /users needs an admin. Pages load lazily:
 * the signed-in pages show their loading state inside the shell (AppLayout), the two
 * full-screen pages on their own.
 *
 * @returns {JSX.Element} The route table.
 */
export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoading fullScreen />}>
      <AppRoutesTable />
    </Suspense>
  );
}

function AppRoutesTable() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="resources" element={<ResourcesPage />} />
        <Route
          path="users"
          element={(
            <ProtectedRoute action="manageUsers">
              <UsersPage />
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
