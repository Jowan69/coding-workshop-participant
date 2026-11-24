import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FormDialog from '../components/FormDialog';
import RowActions from '../components/RowActions';
import { useAuth } from '../context/auth-context';
import { useNotify } from '../context/notification-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useResourceLookup } from '../hooks/useResourceLookup';
import { formatDate, formatPercent } from '../utils/format';
import { allocationFields } from './allocationFields';

const CLOSED = { open: false, record: null };

/**
 * The snackbar text for an over-allocation warning, or null when the save had none.
 *
 * @param {object|null} saved The allocation the API returned.
 * @param {string} name The person's name.
 * @returns {string|null} Warning text.
 */
function overAllocationMessage(saved, name) {
  if (saved?.warning !== 'over_allocated') return null;
  return `Saved, but ${name} is now booked at ${formatPercent(saved.total_allocation_pct)} `
    + `against a capacity of ${formatPercent(saved.capacity_pct)}.`;
}

/**
 * Who works on a project: each allocation's person, role, share of time and dates, with add,
 * edit and delete as the role allows. Over-allocation is allowed, but the save is followed by
 * a warning snackbar with the person's new total.
 *
 * @param {object} props Component props.
 * @param {{id: number, name: string, start_date: string, end_date: string}} props.project
 *   The project; its dates are the defaults for a new allocation.
 * @returns {JSX.Element} The tab.
 */
export default function TeamTab({ project }) {
  const { can } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const notify = useNotify();
  const query = useMemo(() => ({ project_id: project.id }), [project.id]);
  const list = useApiList('/allocations', query);
  const { create, update, remove } = useApiMutation('/allocations', { label: 'Allocation' });
  const people = useResourceLookup();
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const editing = form.record;
  const fields = useMemo(
    () => allocationFields(people.optionsFor(editing?.resource_id ?? null)),
    [people, editing],
  );
  const newDefaults = { start_date: project.start_date, end_date: project.end_date };

  const openCreate = () => setForm({ open: true, record: null });

  const handleSave = async (payload) => {
    const saved = editing
      ? await update(editing.id, payload)
      : await create({ ...payload, project_id: project.id });
    list.reload();
    const warning = overAllocationMessage(saved, people.nameOf(saved?.resource_id));
    if (warning) notify(warning, 'warning');
  };

  const handleDelete = async () => {
    await remove(deletion.record.id);
    list.reload();
  };

  const columns = [
    { key: 'resource_id', label: 'Person', render: (row) => people.nameOf(row.resource_id) },
    { key: 'role_on_project', label: 'Role on project' },
    {
      key: 'allocation_pct',
      label: 'Allocation',
      align: 'right',
      render: (row) => formatPercent(row.allocation_pct),
    },
    {
      key: 'dates',
      label: 'Dates',
      render: (row) => `${formatDate(row.start_date)} – ${formatDate(row.end_date)}`,
    },
  ];

  const rowActions = canWrite || canDelete
    ? (row) => (
      <RowActions
        name={`${people.nameOf(row.resource_id)}'s allocation`}
        onEdit={canWrite ? () => setForm({ open: true, record: row }) : undefined}
        onDelete={canDelete ? () => setDeletion({ open: true, record: row }) : undefined}
      />
    )
    : undefined;

  const emptyState = canWrite
    ? {
      title: 'Nobody is allocated yet',
      message: 'Add people to show who works on this project and how much of their time it takes.',
      action: { label: 'Add person', onClick: openCreate },
    }
    : {
      title: 'Nobody is allocated yet',
      message: 'People appear here once a team lead or project manager allocates them.',
    };

  const deletingName = deletion.record ? people.nameOf(deletion.record.resource_id) : '';

  return (
    <>
      {canWrite && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={openCreate}>
            Add person
          </Button>
        </Box>
      )}
      <DataList
        ariaLabel="Team"
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
        rowActions={rowActions}
        emptyState={emptyState}
      />
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? `Edit ${people.nameOf(editing.resource_id)}'s allocation` : 'Add person to project'}
          fields={fields}
          initialValues={editing ?? newDefaults}
          onSubmit={handleSave}
          onClose={() => setForm((current) => ({ ...current, open: false }))}
          submitLabel={editing ? 'Save changes' : 'Add person'}
        />
      )}
      {canDelete && (
        <ConfirmDialog
          open={deletion.open}
          title="Remove from project?"
          message={deletion.record
            ? `${deletingName} will be removed from ${project.name} (${formatPercent(deletion.record.allocation_pct)}, ${formatDate(deletion.record.start_date)} – ${formatDate(deletion.record.end_date)}).`
            : ''}
          confirmLabel="Remove"
          destructive
          onConfirm={handleDelete}
          onClose={() => setDeletion((current) => ({ ...current, open: false }))}
        />
      )}
    </>
  );
}

TeamTab.propTypes = {
  project: PropTypes.shape({
    id: PropTypes.number.isRequired,
    name: PropTypes.string.isRequired,
    start_date: PropTypes.string,
    end_date: PropTypes.string,
  }).isRequired,
};
