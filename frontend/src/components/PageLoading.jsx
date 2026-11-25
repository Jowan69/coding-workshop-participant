import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';

/**
 * The loading state while a lazily loaded page's code is fetched.
 *
 * @param {object} props Component props.
 * @param {boolean} [props.fullScreen] Centre it on an empty screen (pages without the shell).
 * @returns {JSX.Element} A labelled progress bar.
 */
export default function PageLoading({ fullScreen = false }) {
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={fullScreen
        ? { minHeight: '100vh', display: 'grid', alignContent: 'center', gap: 1, p: 3, bgcolor: 'background.default' }
        : { display: 'grid', gap: 1, py: 2 }}
    >
      <LinearProgress aria-label="Loading page" />
      <Typography variant="body2" color="text.secondary">Loading…</Typography>
    </Box>
  );
}

PageLoading.propTypes = {
  fullScreen: PropTypes.bool,
};
