import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AddIcon from '@mui/icons-material/Add';
import AsOfNote from '../components/AsOfNote';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import RowActions from '../components/RowActions';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { useResourceLookup } from '../hooks/useResourceLookup';
import { formatDate } from '../utils/format';
import { expecting } from '../utils/staleness';
import { DELIVERABLE_STATUS_OPTIONS, statusLabel } from '../utils/status';
import DependenciesDialog from './DependenciesDialog';
import { deliverableFields, isDeliverableOverdue } from './deliverableFields';

const FILTER_NAMES = ['q', 'status'];
const FILTER_SPECS = [{ name: 'status', label: 'Status', options: DELIVERABLE_STATUS_OPTIONS }];
const CLOSED = { open: false, record: null };
/** The sortable columns (API sort keys); the cells are added in the component. */
const SORT_COLUMNS = [
  { key: 'title', label: 'Deliverable', sortKey: 'title' },
  { key: 'status', label: 'Status', sortKey: 'status' },
  { key: 'due_date', label: 'Due', sortKey: 'due_date' },
];
const LIST_OPTIONS = { columns: SORT_COLUMNS, defaultSort: 'due_date' };

function StatusSelect({ deliverable, disabled, onChange }) {
  return (
    <Select
      value={deliverable.status}
      onChange={(event) => onChange(deliverable, event.target.value)}
      disabled={disabled}
      variant="standard"
      disableUnderline
      renderValue={(value) => <StatusChip status={value} />}
      inputProps={{ 'aria-label': `Status of ${deliverable.title}` }}
    >
      {DELIVERABLE_STATUS_OPTIONS.map((option) => (
        <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
      ))}
    </Select>
  );
}

StatusSelect.propTypes = {
  deliverable: PropTypes.shape({ title: PropTypes.string, status: PropTypes.string }).isRequired,
  disabled: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
};

function DueCell({ deliverable }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="body2" component="span" sx={{ whiteSpace: 'nowrap' }}>
        {formatDate(deliverable.due_date)}
      </Typography>
      {isDeliverableOverdue(deliverable) && <StatusChip status="overdue" />}
    </Box>
  );
}

DueCell.propTypes = {
  deliverable: PropTypes.shape({ due_date: PropTypes.string, status: PropTypes.string }).isRequired,
};

/**
 * A project's deliverables: search and filter by status, change a status in place, create,
 * edit and delete as the role allows, and open each one's dependencies.
 *
 * @param {object} props Component props.
 * @param {{id: number, name: string}} props.project The project.
 * @param {() => void} props.onProjectChange Reloads the project header (progress changes).
 * @returns {JSX.Element} The tab.
 */
export default function DeliverablesTab({ project, onProjectChange }) {
  const { can } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const query = useMemo(() => ({ ...filters, project_id: project.id }), [filters, project.id]);
  const list = useApiList('/deliverables', query, LIST_OPTIONS);
  const { create, update, remove, fetchOne } = useApiMutation('/deliverables', {
    label: 'Deliverable', onStale: list.reload,
  });
  const people = useResourceLookup();
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);
  const [links, setLinks] = useState({ ...CLOSED, key: 0 });
  const [statusSaving, setStatusSaving] = useState(null);

  const editing = form.record;
  const fields = useMemo(
    () => deliverableFields(people.optionsFor(editing?.assignee_id ?? null)),
    [people, editing],
  );

  const afterChange = () => {
    list.reload();
    onProjectChange();
  };

  const openCreate = () => setForm({ open: true, record: null });

  const handleSave = async (payload, context) => {
    if (editing) await update(editing.id, payload, undefined, context);
    else await create({ ...payload, project_id: project.id }, undefined, context);
    afterChange();
  };

  const reloadEditing = async () => {
    const fresh = await fetchOne(editing.id);
    setForm({ open: true, record: fresh });
    list.reload();
    return fresh;
  };

  const handleDelete = async () => {
    await remove(deletion.record.id);
    afterChange();
  };

  const changeStatus = async (deliverable, status) => {
    if (status === deliverable.status) return;
    setStatusSaving(deliverable.id);
    try {
      await update(
        deliverable.id,
        expecting(deliverable, { status }),
        `"${deliverable.title}" is now ${statusLabel(status).toLowerCase()}`,
      );
      afterChange();
    } catch {
      // useApiMutation has shown the reason (with Reload if someone else changed it first);
      // the select keeps the saved status.
    } finally {
      setStatusSaving(null);
    }
  };

  const columns = [
    { key: 'title', label: 'Deliverable', sortKey: 'title' },
    {
      key: 'status',
      label: 'Status',
      sortKey: 'status',
      render: (deliverable) => (canWrite ? (
        <StatusSelect
          deliverable={deliverable}
          disabled={statusSaving === deliverable.id}
          onChange={changeStatus}
        />
      ) : <StatusChip status={deliverable.status} />),
    },
    {
      key: 'due_date',
      label: 'Due',
      sortKey: 'due_date',
      render: (deliverable) => <DueCell deliverable={deliverable} />,
    },
    {
      key: 'assignee_id',
      label: 'Assignee',
      render: (deliverable) => people.nameOf(deliverable.assignee_id) ?? 'Unassigned',
    },
  ];

  const rowActions = (deliverable) => (
    <RowActions
      name={deliverable.title}
      onEdit={canWrite ? () => setForm({ open: true, record: deliverable }) : undefined}
      onDelete={canDelete ? () => setDeletion({ open: true, record: deliverable }) : undefined}
    >
      <Tooltip title="Dependencies" describeChild>
        <IconButton
          aria-label={`Dependencies of ${deliverable.title}`}
          onClick={() => setLinks((current) => ({
            open: true, record: deliverable, key: current.key + 1,
          }))}
        >
          <AccountTreeOutlinedIcon />
        </IconButton>
      </Tooltip>
    </RowActions>
  );

  const hasFilters = FILTER_NAMES.some((name) => filters[name]);
  let emptyState;
  if (hasFilters) {
    emptyState = {
      title: 'No deliverables match these filters',
      message: 'Try a different search, or clear the filters to see every deliverable.',
      action: { label: 'Clear filters', onClick: clearFilters },
    };
  } else if (canWrite) {
    emptyState = {
      title: 'No deliverables yet',
      message: 'Add the first deliverable to start tracking progress on this project.',
      action: { label: 'Add deliverable', onClick: openCreate },
    };
  } else {
    emptyState = {
      title: 'No deliverables yet',
      message: 'Deliverables appear here once a team lead or project manager adds them.',
    };
  }

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
          <FilterBar
            ariaLabel="Filter deliverables"
            search={{ label: 'Search deliverables' }}
            filters={FILTER_SPECS}
          />
        </Box>
        {canWrite && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New deliverable
          </Button>
        )}
      </Box>
      <DataList
        ariaLabel="Deliverables"
        columns={columns}
        rows={list.items}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        total={list.total}
        page={list.page}
        rowsPerPage={list.rowsPerPage}
        onPageChange={list.setPage}
        onRowsPerPageChange={list.setRowsPerPage}
        sort={list.sort}
        onSortChange={list.setSort}
        sortChoices={list.sortChoices}
        rowActions={rowActions}
        emptyState={emptyState}
      />
      <AsOfNote date={list.items[0]?.as_of} />
      <DependenciesDialog
        key={links.key}
        open={links.open}
        deliverable={links.record}
        onClose={() => setLinks((current) => ({ ...current, open: false }))}
      />
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? `Edit ${editing.title}` : 'New deliverable'}
          fields={fields}
          initialValues={editing ?? undefined}
          changesOnly={Boolean(editing)}
          onReload={editing ? reloadEditing : undefined}
          onSubmit={handleSave}
          onClose={() => setForm((current) => ({ ...current, open: false }))}
          submitLabel={editing ? 'Save changes' : 'Add deliverable'}
        />
      )}
      {canDelete && (
        <ConfirmDialog
          open={deletion.open}
          title="Delete deliverable?"
          message={deletion.record
            ? `"${deletion.record.title}" and its dependency links will be permanently deleted.`
            : ''}
          confirmLabel="Delete deliverable"
          destructive
          onConfirm={handleDelete}
          onClose={() => setDeletion((current) => ({ ...current, open: false }))}
        />
      )}
    </>
  );
}

DeliverablesTab.propTypes = {
  project: PropTypes.shape({ id: PropTypes.number.isRequired }).isRequired,
  onProjectChange: PropTypes.func.isRequired,
};
