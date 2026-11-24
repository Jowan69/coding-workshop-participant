import { Link as RouterLink } from 'react-router-dom';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import PageHeader from '../components/PageHeader';

/**
 * Shown for any route that does not exist.
 *
 * @returns {JSX.Element} The page.
 */
export default function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
        <SearchOffIcon aria-hidden="true" sx={{ fontSize: 48, color: 'text.secondary' }} />
        <Typography variant="body1" sx={{ mt: 1 }}>
          There is no page at this address. It may have moved, or the link may be wrong.
        </Typography>
        <Button component={RouterLink} to="/" variant="contained" sx={{ mt: 2 }}>
          Go to the dashboard
        </Button>
      </Paper>
    </>
  );
}
