import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useApiGet } from '../hooks/useApiGet';
import { sectionHeadingId } from '../utils/dashboardSections';

function LoadingState() {
  return (
    <Box data-testid="section-loading" aria-hidden="true">
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="text" />
      <Skeleton variant="text" />
      <Skeleton variant="rounded" height={48} sx={{ mt: 1 }} />
    </Box>
  );
}

function EmptyState({ message }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1 }}>
      <InboxOutlinedIcon aria-hidden="true" sx={{ color: 'text.secondary' }} />
      <Typography variant="body1" color="text.secondary">{message}</Typography>
    </Box>
  );
}

EmptyState.propTypes = {
  message: PropTypes.string.isRequired,
};

/**
 * One Dashboard question: the question as a heading, optional controls, and the answer loaded
 * from the API by this section alone, with its own loading, empty and error states. A failure
 * here never affects the other sections.
 *
 * @param {object} props Component props.
 * @param {string} props.id Section id; the heading gets `sectionHeadingId(id)`.
 * @param {string} props.title The business question, e.g. "Which projects are at risk?".
 * @param {string} [props.description] One line on how the answer is worked out.
 * @param {string} props.label What is loaded, for the error title, e.g. "at-risk projects".
 * @param {string|null} props.path Endpoint under /api/tracker; null waits (shows `idle`).
 * @param {Object<string, *>} [props.query] Query parameters.
 * @param {(data: *) => boolean} props.isEmpty Whether a response has nothing to show.
 * @param {string|((data: *) => string)} props.emptyMessage What to say when it is empty.
 * @param {React.ReactNode} [props.controls] Inputs beside the heading, e.g. a picker.
 * @param {React.ReactNode} [props.idle] Shown while `path` is null.
 * @param {(data: *) => React.ReactNode} props.children Renders a non-empty response.
 * @returns {JSX.Element} The section.
 */
export default function InsightSection({
  id, title, description, label, path, query, isEmpty, emptyMessage, controls, idle, children,
}) {
  const headingId = sectionHeadingId(id);
  const { data, loading, error, reload } = useApiGet(path, query);

  let body;
  if (loading) {
    body = <LoadingState />;
  } else if (error) {
    body = (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={reload}>
            Retry
          </Button>
        )}
      >
        <AlertTitle>{`Could not load ${label}`}</AlertTitle>
        {error.message}
      </Alert>
    );
  } else if (data === null || data === undefined) {
    body = idle ?? null;
  } else if (isEmpty(data)) {
    body = <EmptyState message={typeof emptyMessage === 'function' ? emptyMessage(data) : emptyMessage} />;
  } else {
    body = children(data);
  }

  return (
    <Paper
      component="section"
      id={id}
      variant="outlined"
      aria-labelledby={headingId}
      aria-busy={loading || undefined}
      // The app bar is fixed: keep a jumped-to heading clear of it.
      sx={{ p: { xs: 2, md: 3 }, display: 'grid', gap: 2, minWidth: 0, scrollMarginTop: 80 }}
    >
      <Box
        sx={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography id={headingId} variant="h5" component="h2" tabIndex={-1}>{title}</Typography>
          {description && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{description}</Typography>
          )}
        </Box>
        {controls}
      </Box>
      {body}
    </Paper>
  );
}

InsightSection.propTypes = {
  id: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
  label: PropTypes.string.isRequired,
  path: PropTypes.string,
  query: PropTypes.object,
  isEmpty: PropTypes.func.isRequired,
  emptyMessage: PropTypes.oneOfType([PropTypes.string, PropTypes.func]).isRequired,
  controls: PropTypes.node,
  idle: PropTypes.node,
  children: PropTypes.func.isRequired,
};
