import { useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InsightsIcon from '@mui/icons-material/Insights';
import { useAuth } from '../context/auth-context';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEMO_EMAILS = ['admin@acme.test', 'manager@acme.test', 'lead@acme.test', 'viewer@acme.test'];

function validate({ email, password }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address';
  if (!password) errors.password = 'Password is required';
  return errors;
}

function returnPath(state) {
  const from = state?.from;
  if (!from?.pathname || from.pathname === '/login') return '/';
  return `${from.pathname}${from.search ?? ''}`;
}

/**
 * Sign-in form. Validates before submitting, shows server errors in an alert, and returns the
 * user to the page they were heading to.
 *
 * @returns {JSX.Element} The sign-in page.
 */
export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const location = useLocation();
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  if (isAuthenticated) return <Navigate to={returnPath(location.state)} replace />;

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError(null);
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (nextErrors.email) {
      emailRef.current?.focus();
      return;
    }
    if (nextErrors.password) {
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      // On success the session updates and the redirect above takes over.
      await login(values.email.trim(), values.password);
    } catch (error) {
      setErrors({
        email: error.fieldErrors?.email && `Email ${error.fieldErrors.email}`,
        password: error.fieldErrors?.password && `Password ${error.fieldErrors.password}`,
      });
      setServerError(error.message || 'Sign-in failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <title>Sign in · ACME Project Tracker</title>
      <Paper variant="outlined" sx={{ width: '100%', maxWidth: 420, p: { xs: 3, sm: 4 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3, color: 'primary.main' }}>
          <InsightsIcon aria-hidden="true" />
          <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
            ACME Project Tracker
          </Typography>
        </Box>
        <Typography variant="h1" sx={{ mb: 1 }}>Sign in</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Project status, deadline risk, resources and budget in one place.
        </Typography>

        {serverError && <Alert severity="error" sx={{ mb: 2 }}>{serverError}</Alert>}

        <Box component="form" noValidate onSubmit={handleSubmit} aria-label="Sign in">
          <TextField
            name="email"
            type="email"
            label="Email"
            autoComplete="username"
            autoFocus
            required
            fullWidth
            margin="normal"
            value={values.email}
            onChange={handleChange}
            disabled={submitting}
            error={Boolean(errors.email)}
            inputRef={emailRef}
            helperText={(
              <>
                {errors.email && <Box component="span" sx={{ display: 'block' }}>{errors.email}</Box>}
                <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>
                  {`Demo accounts: ${DEMO_EMAILS.join(', ')}`}
                </Box>
              </>
            )}
          />
          <TextField
            name="password"
            type="password"
            label="Password"
            autoComplete="current-password"
            required
            fullWidth
            margin="normal"
            value={values.password}
            onChange={handleChange}
            disabled={submitting}
            error={Boolean(errors.password)}
            helperText={errors.password}
            inputRef={passwordRef}
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            fullWidth
            disabled={submitting}
            sx={{ mt: 2 }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
