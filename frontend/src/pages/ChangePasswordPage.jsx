import { useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LockResetIcon from '@mui/icons-material/LockReset';
import { useAuth } from '../context/auth-context';
import { PASSWORD_MAX } from '../utils/passwordRules';
import { changePasswordFields } from './passwordFields';

const FIELDS = changePasswordFields('Temporary password');
const EMPTY = Object.fromEntries(FIELDS.map((field) => [field.name, '']));

function validate(values) {
  const errors = {};
  FIELDS.forEach((field) => {
    const value = values[field.name];
    const message = value === '' ? `${field.label} is required` : field.validate?.(value, values);
    if (message) errors[field.name] = message;
  });
  return errors;
}

/**
 * The blocking screen for a user whose password is temporary (an admin reset it). Until they
 * choose a new one the API refuses everything else, so this page is all they can use: change
 * the password or sign out. Anyone else is sent on to the app.
 *
 * @returns {JSX.Element} The page.
 */
export default function ChangePasswordPage() {
  const { user, isAuthenticated, changePassword, logout } = useAuth();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const inputs = useRef({});

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user.must_change_password) return <Navigate to="/" replace />;

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  };

  const showErrors = (nextErrors) => {
    setErrors(nextErrors);
    const first = FIELDS.find((field) => nextErrors[field.name]);
    if (first) inputs.current[first.name]?.focus();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setServerError(null);
    const clientErrors = validate(values);
    if (Object.keys(clientErrors).length > 0) {
      showErrors(clientErrors);
      return;
    }
    setSubmitting(true);
    try {
      // On success the session's user loses the flag and the redirect above takes over.
      await changePassword(values.current_password, values.new_password);
    } catch (error) {
      const fieldErrors = {};
      FIELDS.forEach((field) => {
        const message = error.fieldErrors?.[field.name];
        if (message) fieldErrors[field.name] = `${field.label} ${message}`;
      });
      setSubmitting(false);
      if (Object.keys(fieldErrors).length > 0) showErrors(fieldErrors);
      else setServerError(error.message || 'Could not change the password. Please try again.');
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
      <title>Choose a new password · ACME Project Tracker</title>
      <Paper variant="outlined" sx={{ width: '100%', maxWidth: 460, p: { xs: 3, sm: 4 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3, color: 'primary.main' }}>
          <LockResetIcon aria-hidden="true" />
          <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
            ACME Project Tracker
          </Typography>
        </Box>
        <Typography variant="h1" sx={{ mb: 1 }}>Choose a new password</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {`${user.full_name}, an admin gave you a temporary password. Choose your own to continue.`}
        </Typography>

        {serverError && <Alert severity="error" sx={{ mb: 2 }}>{serverError}</Alert>}

        <Box component="form" noValidate onSubmit={handleSubmit} aria-label="Choose a new password">
          {FIELDS.map((field, index) => (
            <TextField
              key={field.name}
              name={field.name}
              type="password"
              label={field.label}
              autoComplete={field.autoComplete ?? 'new-password'}
              autoFocus={index === 0}
              required
              fullWidth
              margin="normal"
              value={values[field.name]}
              onChange={handleChange}
              disabled={submitting}
              error={Boolean(errors[field.name])}
              helperText={errors[field.name] || field.helperText}
              inputRef={(element) => { inputs.current[field.name] = element; }}
              slotProps={{ htmlInput: { maxLength: PASSWORD_MAX } }}
            />
          ))}
          <Button type="submit" variant="contained" size="large" fullWidth disabled={submitting} sx={{ mt: 2 }}>
            {submitting ? 'Saving…' : 'Change password'}
          </Button>
          <Button fullWidth onClick={logout} disabled={submitting} sx={{ mt: 1 }}>
            Sign out
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
