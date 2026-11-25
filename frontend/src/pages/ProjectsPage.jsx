import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import AsOfNote from '../components/AsOfNote';
import BudgetBar from '../components/BudgetBar';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import PageHeader from '../components/PageHeader';
import ProgressBar from '../components/ProgressBar';
import RowActions from '../components/RowActions';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiGet } from '../hooks/useApiGet';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useDepartments } from '../hooks/useDepartments';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { formatDate } from '../utils/format';
import { PROJECT_STATUS_OPTIONS } from '../utils/status';
import { isProjectOverdue, ownerOptions, projectFields } from './projectFields';

const FILTER_NAMES = ['q', 'status', 'department'];
const CLOSED = { open: false, record: null };

function DeadlineCell({ project }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
      <Typography variant="body2" component="span" sx={{ whiteSpace: 'nowrap' }}>
        {formatDate(project.end_date)}
      </Typography>
      {isProjectOverdue(project) && <StatusChip status="overdue" />}
    </Box>
  );
}

DeadlineCell.propTypes = {
  project: PropTypes.shape({ end_date: PropTypes.string, status: PropTypes.string }).isRequired,
};

const COLUMNS = [
  { key: 'name', label: 'Name', sortKey: 'name' },
  { key: 'department', label: 'Department' },
  {
    key: 'status',
    label: 'Status',
    sortKey: 'status',
    render: (project) => <StatusChip status={project.status} />,
  },
  {
    key: 'end_date',
    label: 'Deadline',
    sortKey: 'end_date',
    render: (project) => <DeadlineCell project={project} />,
  },
  {
    key: 'percent_complete',
    label: '% complete',
    render: (project) => (
      <ProgressBar value={project.percent_complete} label={`${project.name} percent complete`} />
    ),
  },
  {
    key: 'budget',
    label: 'Budget used',
    render: (project) => (
      <BudgetBar
        planned={project.budget_planned}
        spent={project.budget_spent}
        label={`${project.name} budget used`}
      />
    ),
  },
];

/**
 * Projects: search and filter, then create, edit and delete as the role allows.
 * A row opens the project's page. A new project's owner defaults to the signed-in user and
 * can be changed or cleared; an edit sends only what changed and is refused if someone else
 * changed the project first (the form then offers to reload it).
 *
 * @returns {JSX.Element} The projects page.
 */
export default function ProjectsPage() {
  const { can, user } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const list = useApiList('/projects', filters, { columns: COLUMNS, defaultSort: 'name' });
  const { create, update, remove, fetchOne } = useApiMutation('/projects', {
    label: 'Project', onStale: list.reload,
  });
  const [changes, setChanges] = useState(0);
  const departments = useDepartments('/projects', changes);
  // Only people who can edit projects may list the users to choose an owner from.
  const users = useApiGet(canWrite ? '/auth/users/options' : null);
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const owners = useMemo(
    () => ownerOptions(users.data?.items, user, form.record),
    [users.data, user, form.record],
  );
  const fields = useMemo(() => projectFields(departments, owners), [departments, owners]);
  const filterSpecs = useMemo(() => [
    { name: 'status', label: 'Status', options: PROJECT_STATUS_OPTIONS },
    {
      name: 'department',
      label: 'Department',
      options: departments.map((name) => ({ value: name, label: name })),
    },
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
      title: 'No projects match these filters',
      message: 'Try a different search, or clear the filters to see every project.',
      action: { label: 'Clear filters', onClick: clearFilters },
    };
  } else if (canWrite) {
    emptyState = {
      title: 'No projects yet',
      message: 'Create the first project to start tracking its deadline, people and budget.',
      action: { label: 'Create project', onClick: openCreate },
    };
  } else {
    emptyState = {
      title: 'No projects yet',
      message: 'Projects appear here once a team lead or project manager creates them.',
    };
  }

  const rowActions = canWrite || canDelete
    ? (project) => (
      <RowActions
        name={project.name}
        onEdit={canWrite ? () => setForm({ open: true, record: project }) : undefined}
        onDelete={canDelete ? () => setDeletion({ open: true, record: project }) : undefined}
      />
    )
    : undefined;

  return (
    <>
      <PageHeader
        title="Projects"
        description="Status, deadlines, progress and budget for every ACME project."
        actions={canWrite && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New project
          </Button>
        )}
      />
      <FilterBar
        ariaLabel="Filter projects"
        search={{ label: 'Search projects' }}
        filters={filterSpecs}
      />
      <DataList
        ariaLabel="Projects"
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
        getRowHref={(project) => `/projects/${project.id}`}
        rowActions={rowActions}
        emptyState={emptyState}
      />
      <AsOfNote date={list.items[0]?.as_of} />
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? `Edit ${editing.name}` : 'New project'}
          fields={fields}
          initialValues={editing ?? { owner_id: user?.id }}
          changesOnly={Boolean(editing)}
          onReload={editing ? reloadEditing : undefined}
          onSubmit={handleSave}
          onClose={() => setForm((current) => ({ ...current, open: false }))}
          submitLabel={editing ? 'Save changes' : 'Create project'}
        />
      )}
      {canDelete && (
        <ConfirmDialog
          open={deletion.open}
          title="Delete project?"
          message={deletion.record
            ? `"${deletion.record.name}" and all of its deliverables, allocations and budget entries will be permanently deleted.`
            : ''}
          confirmLabel="Delete project"
          destructive
          onConfirm={handleDelete}
          onClose={() => setDeletion((current) => ({ ...current, open: false }))}
        />
      )}
    </>
  );
}
