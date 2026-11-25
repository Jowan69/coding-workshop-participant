import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/**
 * The page title (the page's only h1), an optional description and the page's main actions.
 *
 * @param {object} props Component props.
 * @param {string} props.title Page title.
 * @param {string} [props.description] One line under the title.
 * @param {React.ReactNode} [props.actions] Buttons on the right (wrap below on phones).
 * @returns {JSX.Element} The header.
 */
export default function PageHeader({ title, description, actions }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 2,
        mb: 3,
      }}
    >
      {/* React 19 hoists <title> into the document head. */}
      <title>{`${title} · ACME Project Tracker`}</title>
      {/* min-width 0 lets a long unbroken title wrap instead of widening the page. */}
      <Box sx={{ minWidth: 0, maxWidth: '100%' }}>
        <Typography variant="h1" component="h1" sx={{ overflowWrap: 'anywhere' }}>{title}</Typography>
        {description && (
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {description}
          </Typography>
        )}
      </Box>
      {actions && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
          {actions}
        </Box>
      )}
    </Box>
  );
}

PageHeader.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
  actions: PropTypes.node,
};
