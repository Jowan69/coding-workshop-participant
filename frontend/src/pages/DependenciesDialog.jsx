import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddLinkIcon from '@mui/icons-material/AddLink';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiGet } from '../hooks/useApiGet';
import { useApiMutation } from '../hooks/useApiMutation';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { formatDate } from '../utils/format';

const linkShape = PropTypes.shape({
  id: PropTypes.number.isRequired,
  title: PropTypes.string.isRequired,
  status: PropTypes.string.isRequired,
  due_date: PropTypes.string,
});

function LinkList({ title, hint, items, emptyText, onRemove, removingId }) {
  const headingId = useId();
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography id={headingId} variant="subtitle2" component="h3">{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{hint}</Typography>
      {items.length === 0 ? (
        <Typography variant="body2" sx={{ fontStyle: 'italic' }}>{emptyText}</Typography>
      ) : (
        <List dense disablePadding aria-labelledby={headingId}>
          {items.map((item) => (
            <ListItem
              key={item.id}
              disableGutters
              divider
              secondaryAction={onRemove && (
                <Tooltip title="Remove link" describeChild>
                  <IconButton
                    edge="end"
                    aria-label={`Remove dependency on ${item.title}`}
                    onClick={() => onRemove(item)}
                    disabled={removingId === item.id}
                  >
                    <LinkOffIcon />
                  </IconButton>
                </Tooltip>
              )}
            >
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 1,
                  width: '100%',
                  pr: onRemove ? 6 : 0,
                }}
              >
                <Box sx={{ flex: '1 1 160px', minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{item.title}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {`Due ${formatDate(item.due_date)}`}
                  </Typography>
                </Box>
                <StatusChip status={item.status} />
              </Box>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}

LinkList.propTypes = {
  title: PropTypes.string.isRequired,
  hint: PropTypes.string.isRequired,
  items: PropTypes.arrayOf(linkShape).isRequired,
  emptyText: PropTypes.string.isRequired,
  onRemove: PropTypes.func,
  removingId: PropTypes.number,
};

function AddDependency({ deliverable, linkedIds, onAdd }) {
  const isDesktop = useIsDesktop();
  const [choice, setChoice] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // The picker only offers deliverables of the same project; cycles are left to the API,
  // which explains which link closes the loop.
  const siblings = useApiGet('/deliverables', {
    project_id: deliverable.project_id,
    sort: 'title',
    limit: 100,
  });
  const options = (siblings.data?.items ?? [])
    .filter((item) => item.id !== deliverable.id && !linkedIds.has(item.id))
    .map((item) => ({ value: item.id, label: item.title }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!choice) {
      setError('Choose a deliverable to link');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(choice);
      setChoice(null);
    } catch (failure) {
      setError(failure?.message || 'Could not add the dependency');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={handleSubmit}
      aria-label="Add a dependency"
      sx={{ display: 'flex', flexWrap: isDesktop ? 'nowrap' : 'wrap', alignItems: 'flex-start', gap: 1 }}
    >
      <Autocomplete
        options={options}
        value={choice}
        onChange={(event, option) => {
          setChoice(option);
          setError(null);
        }}
        getOptionLabel={(option) => option.label}
        isOptionEqualToValue={(option, current) => option.value === current.value}
        loading={siblings.loading}
        disabled={busy}
        noOptionsText="No other deliverables in this project to link"
        sx={{ flex: '1 1 260px', minWidth: 0 }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Depends on"
            error={Boolean(error)}
            helperText={error || 'Pick another deliverable from this project'}
          />
        )}
      />
      <Button
        type="submit"
        variant="contained"
        disabled={busy}
        startIcon={<AddLinkIcon />}
        sx={{ mt: 1, flex: isDesktop ? '0 0 auto' : '1 1 100%' }}
      >
        {busy ? 'Adding…' : 'Add'}
      </Button>
    </Box>
  );
}

AddDependency.propTypes = {
  deliverable: PropTypes.shape({
    id: PropTypes.number.isRequired,
    project_id: PropTypes.number.isRequired,
  }).isRequired,
  linkedIds: PropTypes.instanceOf(Set).isRequired,
  onAdd: PropTypes.func.isRequired,
};

/**
 * One deliverable's dependencies: what it depends on (removable by managers), what depends on
 * it, and a picker to add a link within the same project. When the API refuses a link (a
 * cycle, a duplicate) its reason is shown on the picker. Full screen on phones.
 *
 * Mount it with a new `key` each time it opens, so it loads fresh links.
 *
 * @param {object} props Component props.
 * @param {boolean} props.open Whether the dialog is shown.
 * @param {{id: number, project_id: number, title: string}|null} props.deliverable The
 *   deliverable; kept while the dialog closes.
 * @param {() => void} props.onClose Called to close the dialog.
 * @returns {JSX.Element} The dialog.
 */
export default function DependenciesDialog({ open, deliverable, onClose }) {
  const isDesktop = useIsDesktop();
  const titleId = useId();
  const { can } = useAuth();
  const id = deliverable?.id;
  const links = useApiGet(id ? `/deliverables/${id}/dependencies` : null);
  const { create, remove } = useApiMutation(`/deliverables/${id}/dependencies`, {
    label: 'Dependency',
  });
  const [removingId, setRemovingId] = useState(null);

  const dependsOn = links.data?.items ?? [];
  const dependents = links.data?.dependents ?? [];

  const handleAdd = async (choice) => {
    await create(
      { depends_on_id: choice.value },
      `"${deliverable.title}" now depends on "${choice.label}"`,
    );
    links.reload();
  };

  const handleRemove = async (target) => {
    setRemovingId(target.id);
    try {
      await remove(target.id, `"${deliverable.title}" no longer depends on "${target.title}"`);
      links.reload();
    } catch {
      // useApiMutation has shown the reason; the link stays listed.
    } finally {
      setRemovingId(null);
    }
  };

  let body;
  if (links.error) {
    body = (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={links.reload}>
            Retry
          </Button>
        )}
      >
        {`Could not load the dependencies. ${links.error.message}`}
      </Alert>
    );
  } else if (!links.data) {
    body = (
      <Box aria-busy="true" aria-label="Loading dependencies">
        <Skeleton variant="text" width="40%" />
        <Skeleton variant="rounded" height={56} sx={{ mb: 2 }} />
        <Skeleton variant="text" width="40%" />
        <Skeleton variant="rounded" height={56} />
      </Box>
    );
  } else {
    body = (
      <Box sx={{ display: 'grid', gap: 3 }}>
        <LinkList
          title="Depends on"
          hint="Must be finished before this one can be."
          items={dependsOn}
          emptyText="Does not depend on anything."
          onRemove={can('delete') ? handleRemove : undefined}
          removingId={removingId}
        />
        <LinkList
          title="Needed by"
          hint="Waiting for this one to finish."
          items={dependents}
          emptyText="Nothing depends on this yet."
        />
        {can('write') && (
          <AddDependency
            deliverable={deliverable}
            linkedIds={new Set(dependsOn.map((item) => item.id))}
            onAdd={handleAdd}
          />
        )}
      </Box>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={!isDesktop}
      fullWidth
      maxWidth="sm"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>{`Dependencies: ${deliverable?.title ?? ''}`}</DialogTitle>
      <DialogContent dividers>{deliverable && body}</DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

DependenciesDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  deliverable: PropTypes.shape({
    id: PropTypes.number.isRequired,
    project_id: PropTypes.number.isRequired,
    title: PropTypes.string.isRequired,
  }),
  onClose: PropTypes.func.isRequired,
};
