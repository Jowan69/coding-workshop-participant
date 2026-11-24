import PropTypes from 'prop-types';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import ConstructionIcon from '@mui/icons-material/Construction';
import PageHeader from '../components/PageHeader';

/**
 * A screen that is routed and reachable but not built yet.
 *
 * @param {object} props Component props.
 * @param {string} props.title Page title.
 * @param {string} [props.description] What the screen will show.
 * @returns {JSX.Element} The placeholder.
 */
export default function PlaceholderPage({ title, description }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
        <ConstructionIcon aria-hidden="true" sx={{ fontSize: 48, color: 'text.secondary' }} />
        <Typography variant="h6" component="h2" sx={{ mt: 1 }}>Coming soon</Typography>
        <Typography variant="body2" color="text.secondary">
          This screen is not available yet.
        </Typography>
      </Paper>
    </>
  );
}

PlaceholderPage.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
};
