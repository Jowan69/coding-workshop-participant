import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import AllocationBar from '../components/AllocationBar';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import PageHeader from '../components/PageHeader';
import RowActions from '../components/RowActions';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useDepartments } from '../hooks/useDepartments';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { ACTIVE_FILTER_OPTIONS, resourceFields } from './resourceFields';

const FILTER_NAMES = ['q', 'department', 'is_active'];
const CLOSED = { open: false, record: null };

function NameCell({ person }) {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, maxWidth: '100%' }}
    >
      <Box component="span" sx={{ minWidth: 0 }}>{person.full_name}</Box>
      {!person.is_active && <StatusChip status="inactive" />}
    </Box>
  );
}

NameCell.propTypes = {
  person: PropTypes.shape({ full_name: PropTypes.string, is_active: PropTypes.bool }).isRequired,
};

const COLUMNS = [
  {
    key: 'full_name',
    label: 'Name',
    sortKey: 'full_name',
    render: (person) => <NameCell person={person} />,
  },
  { key: 'job_title', label: 'Job title' },
  { key: 'department', label: 'Department', sortKey: 'department' },
  {
    key: 'allocation_today_pct',
    label: 'Allocated today',
    render: (person) => <AllocationBar value={person.allocation_today_pct} name={person.full_name} />,
  },
];

/**
 * Team members (resources): search and filter by department and active status, see each
 * person's allocation today (warning style above 100%), and create, edit and delete as the
 * role allows.
 *
 * @returns {JSX.Element} The resources page.
 */
export default function ResourcesPage() {
  const { can } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const list = useApiList('/resources', filters, { columns: COLUMNS, defaultSort: 'full_name' });
  const { create, update, remove, fetchOne } = useApiMutation('/resources', {
    label: 'Person', onStale: list.reload,
  });
  const [changes, setChanges] = useState(0);
  const departments = useDepartments('/resources', changes);
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const fields = useMemo(() => resourceFields(departments), [departments]);
  const filterSpecs = useMemo(() => [
    {
      name: 'department',
      label: 'Department',
      options: departments.map((name) => ({ value: name, label: name })),
    },
    { name: 'is_active', label: 'Status', options: ACTIVE_FILTER_OPTIONS },
  ], [departments]);

  const afterChange = () => {
    list.reload();
    setChanges((count) => count + 1);
  };

  const openCreate = () => setForm({ open: true, record: null });
  const editing = form.record;

  const handleSave = async (payload, context) => {
    if (editing) await update(editing.id, payload, undefined, context);
    else await create(payload, undefined, context);
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

  const hasFilters = FILTER_NAMES.some((name) => filters[name]);
  let emptyState;
  if (hasFilters) {
    emptyState = {
      title: 'Nobody matches these filters',
      message: 'Try a different search, or clear the filters to see everyone.',
      action: { label: 'Clear filters', onClick: clearFilters },
    };
  } else if (canWrite) {
    emptyState = {
      title: 'No team members yet',
      message: 'Add the people who work on ACME projects to plan their time.',
      action: { label: 'Add person', onClick: openCreate },
    };
  } else {
    emptyState = {
      title: 'No team members yet',
      message: 'People appear here once a team lead or project manager adds them.',
    };
  }

  const rowActions = canWrite || canDelete
    ? (person) => (
      <RowActions
        name={person.full_name}
        onEdit={canWrite ? () => setForm({ open: true, record: person }) : undefined}
        onDelete={canDelete ? () => setDeletion({ open: true, record: person }) : undefined}
      />
    )
    : undefined;

  return (
    <>
      <PageHeader
        title="Resources"
        description="Team members, their capacity and how much of it is booked today."
        actions={canWrite && (
          <Button variant="contained" startIcon={<PersonAddIcon />} onClick={openCreate}>
            Add person
          </Button>
        )}
      />
      <FilterBar
        ariaLabel="Filter team members"
        search={{ label: 'Search by name, email or job title' }}
        filters={filterSpecs}
      />
      <DataList
        ariaLabel="Team members"
        columns={COLUMNS}
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
          title={editing ? `Edit ${editing.full_name}` : 'Add person'}
          fields={fields}
          initialValues={editing ?? undefined}
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
          title="Delete person?"
          message={deletion.record ? (
            <>
              {`${deletion.record.full_name} will be deleted, their allocations removed and their deliverables unassigned.`}
              <Typography component="span" sx={{ display: 'block', mt: 1 }}>
                To keep their history, edit them and set their status to Inactive instead.
              </Typography>
            </>
          ) : ''}
          confirmLabel="Delete person"
          destructive
          onConfirm={handleDelete}
          onClose={() => setDeletion((current) => ({ ...current, open: false }))}
        />
      )}
    </>
  );
}
