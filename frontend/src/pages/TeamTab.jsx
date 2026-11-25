import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import RowActions from '../components/RowActions';
import { useAuth } from '../context/auth-context';
import { useNotify } from '../context/notification-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { useResourceLookup } from '../hooks/useResourceLookup';
import { formatDate, formatPercent } from '../utils/format';
import { allocationFields } from './allocationFields';

const CLOSED = { open: false, record: null };
const FILTER_NAMES = ['resource_id', 'active_on'];
/** The sortable columns (API sort keys); the cells are added in the component. */
const SORT_COLUMNS = [
  { key: 'allocation_pct', label: 'Allocation', sortKey: 'allocation_pct' },
  { key: 'start_date', label: 'Start date', sortKey: 'start_date' },
  { key: 'end_date', label: 'End date', sortKey: 'end_date' },
];
const LIST_OPTIONS = { columns: SORT_COLUMNS, defaultSort: 'start_date' };

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
 * Who works on a project: each allocation's person, role, share of time and dates, with
 * filters for one person and for the allocations active on a day, and add, edit and delete as
 * the role allows. Over-allocation is allowed, but the save is followed by
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
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const query = useMemo(() => ({ ...filters, project_id: project.id }), [filters, project.id]);
  const list = useApiList('/allocations', query, LIST_OPTIONS);
  const { create, update, remove, fetchOne } = useApiMutation('/allocations', {
    label: 'Allocation', onStale: list.reload,
  });
  const people = useResourceLookup();
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const editing = form.record;
  const fields = useMemo(
    () => allocationFields(people.optionsFor(editing?.resource_id ?? null)),
    [people, editing],
  );
  const newDefaults = { start_date: project.start_date, end_date: project.end_date };
  const filterSpecs = useMemo(() => [
    {
      name: 'resource_id',
      label: 'Person',
      options: people.resources.map((person) => ({ value: String(person.id), label: person.full_name })),
    },
    { name: 'active_on', label: 'Active on', type: 'date' },
  ], [people]);

  const openCreate = () => setForm({ open: true, record: null });

  const reloadEditing = async () => {
    const fresh = await fetchOne(editing.id);
    setForm({ open: true, record: fresh });
    list.reload();
    return fresh;
  };

  const handleSave = async (payload, context) => {
    const saved = editing
      ? await update(editing.id, payload, undefined, context)
      : await create({ ...payload, project_id: project.id }, undefined, context);
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
      sortKey: 'allocation_pct',
      align: 'right',
      render: (row) => formatPercent(row.allocation_pct),
    },
    {
      key: 'dates',
      label: 'Dates',
      sortKey: 'start_date', // the header sorts by start; the phone select also offers the end
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

  const hasFilters = FILTER_NAMES.some((name) => filters[name]);
  let emptyState;
  if (hasFilters) {
    emptyState = {
      title: 'No allocations match these filters',
      message: 'Try another person or date, or clear the filters to see the whole team.',
      action: { label: 'Clear filters', onClick: clearFilters },
    };
  } else if (canWrite) {
    emptyState = {
      title: 'Nobody is allocated yet',
      message: 'Add people to show who works on this project and how much of their time it takes.',
      action: { label: 'Add person', onClick: openCreate },
    };
  } else {
    emptyState = {
      title: 'Nobody is allocated yet',
      message: 'People appear here once a team lead or project manager allocates them.',
    };
  }

  const deletingName = deletion.record ? people.nameOf(deletion.record.resource_id) : '';

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
          <FilterBar ariaLabel="Filter team" filters={filterSpecs} />
        </Box>
        {canWrite && (
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={openCreate} sx={{ mb: 2 }}>
            Add person
          </Button>
        )}
      </Box>
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
        sort={list.sort}
        onSortChange={list.setSort}
        sortChoices={list.sortChoices}
        rowActions={rowActions}
        emptyState={emptyState}
      />
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? `Edit ${people.nameOf(editing.resource_id)}'s allocation` : 'Add person to project'}
          fields={fields}
          initialValues={editing ?? newDefaults}
          changesOnly={Boolean(editing)}
          onReload={editing ? reloadEditing : undefined}
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
