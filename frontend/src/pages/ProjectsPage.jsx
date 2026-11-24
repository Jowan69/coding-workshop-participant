import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import PageHeader from '../components/PageHeader';
import ProgressBar from '../components/ProgressBar';
import StatusChip from '../components/StatusChip';
import { useAuth } from '../context/auth-context';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useDepartments } from '../hooks/useDepartments';
import { useFilterParams } from '../hooks/useFilterParams';
import { formatCurrency, formatDate } from '../utils/format';
import { PROJECT_STATUS_OPTIONS } from '../utils/status';
import { isProjectOverdue, projectFields } from './projectFields';

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

function BudgetCell({ project }) {
  const planned = Number(project.budget_planned ?? 0);
  if (project.budget_spent === undefined || project.budget_spent === null) {
    return <Typography variant="body2" color="text.secondary">—</Typography>;
  }
  const spent = Number(project.budget_spent);
  if (!(planned > 0)) {
    return <Typography variant="body2">{`${formatCurrency(spent)} spent, no budget set`}</Typography>;
  }
  const percent = (spent / planned) * 100;
  return (
    <ProgressBar
      value={percent}
      label={`${project.name} budget used`}
      valueText={`${formatCurrency(spent)} of ${formatCurrency(planned)} (${Math.round(percent)}%)`}
    />
  );
}

BudgetCell.propTypes = {
  project: PropTypes.shape({
    name: PropTypes.string,
    budget_planned: PropTypes.number,
    budget_spent: PropTypes.number,
  }).isRequired,
};

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'department', label: 'Department' },
  { key: 'status', label: 'Status', render: (project) => <StatusChip status={project.status} /> },
  { key: 'end_date', label: 'Deadline', render: (project) => <DeadlineCell project={project} /> },
  {
    key: 'percent_complete',
    label: '% complete',
    render: (project) => (
      <ProgressBar value={project.percent_complete} label={`${project.name} percent complete`} />
    ),
  },
  { key: 'budget', label: 'Budget used', render: (project) => <BudgetCell project={project} /> },
];

/**
 * Projects: search and filter, then create, edit and delete as the role allows.
 * A row opens the project's page.
 *
 * @returns {JSX.Element} The projects page.
 */
export default function ProjectsPage() {
  const { can } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const [, setParams] = useSearchParams();
  const filters = useFilterParams(FILTER_NAMES);
  const list = useApiList('/projects', filters);
  const { create, update, remove } = useApiMutation('/projects', { label: 'Project' });
  const [changes, setChanges] = useState(0);
  const departments = useDepartments(changes);
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const fields = useMemo(() => projectFields(departments), [departments]);
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

  const handleSave = async (payload) => {
    if (editing) await update(editing.id, payload);
    else await create(payload);
    afterChange();
  };

  const handleDelete = async () => {
    await remove(deletion.record.id);
    afterChange();
  };

  const clearFilters = () => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      FILTER_NAMES.forEach((name) => next.delete(name));
      return next;
    }, { replace: true });
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
      <>
        {canWrite && (
          <Tooltip title="Edit" describeChild>
            <IconButton
              aria-label={`Edit ${project.name}`}
              onClick={() => setForm({ open: true, record: project })}
            >
              <EditOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
        {canDelete && (
          <Tooltip title="Delete" describeChild>
            <IconButton
              aria-label={`Delete ${project.name}`}
              color="error"
              onClick={() => setDeletion({ open: true, record: project })}
            >
              <DeleteOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
      </>
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
        getRowHref={(project) => `/projects/${project.id}`}
        rowActions={rowActions}
        emptyState={emptyState}
      />
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? `Edit ${editing.name}` : 'New project'}
          fields={fields}
          initialValues={editing ?? undefined}
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
