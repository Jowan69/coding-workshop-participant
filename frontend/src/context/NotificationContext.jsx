import { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import { NotificationContext } from './notification-context';

const DURATION = { success: 4000, info: 5000, warning: 7000, error: 8000 };

/**
 * Shows one snackbar at a time; a new message replaces the current one.
 * Errors are announced assertively, everything else politely.
 *
 * @param {object} props Component props.
 * @param {React.ReactNode} props.children The app.
 * @returns {JSX.Element} The provider and its snackbar.
 */
export function NotificationProvider({ children }) {
  const [message, setMessage] = useState(null);

  const notify = useCallback((text, severity = 'success') => {
    setMessage({ text, severity, key: Date.now() });
  }, []);

  const handleClose = (event, reason) => {
    if (reason === 'clickaway') return;
    setMessage((current) => (current ? { ...current, open: false } : current));
  };

  const value = useMemo(() => ({ notify }), [notify]);
  const open = Boolean(message) && message.open !== false;

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <Snackbar
        key={message?.key}
        open={open}
        autoHideDuration={DURATION[message?.severity] ?? DURATION.info}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {message ? (
          <Alert
            onClose={handleClose}
            severity={message.severity}
            variant="filled"
            role={message.severity === 'error' ? 'alert' : 'status'}
            sx={{ width: '100%' }}
          >
            {message.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </NotificationContext.Provider>
  );
}

NotificationProvider.propTypes = {
  children: PropTypes.node.isRequired,
};
