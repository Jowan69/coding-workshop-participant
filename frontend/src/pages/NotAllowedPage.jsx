import { Link as RouterLink } from 'react-router-dom';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import LockIcon from '@mui/icons-material/Lock';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../context/auth-context';
import { ROLE_LABELS } from '../utils/permissions';

/**
 * Shown when a signed-in user opens a page their role cannot use.
 *
 * @returns {JSX.Element} The page.
 */
export default function NotAllowedPage() {
  const { role } = useAuth();
  return (
    <>
      <PageHeader title="Not allowed" />
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
        <LockIcon aria-hidden="true" sx={{ fontSize: 48, color: 'text.secondary' }} />
        <Typography variant="h6" component="h2" sx={{ mt: 1 }}>
          You do not have access to this page
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {`Your role (${ROLE_LABELS[role] ?? role}) cannot open it. Ask a PMO admin if you need access.`}
        </Typography>
        <Button component={RouterLink} to="/" variant="contained" sx={{ mt: 2 }}>
          Go to the dashboard
        </Button>
      </Paper>
    </>
  );
}
