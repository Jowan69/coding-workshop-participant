import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import BudgetSummary from '../components/BudgetSummary';
import ConfirmDialog from '../components/ConfirmDialog';
import DataList from '../components/DataList';
import FilterBar from '../components/FilterBar';
import FormDialog from '../components/FormDialog';
import RowActions from '../components/RowActions';
import { useAuth } from '../context/auth-context';
import { useApiGet } from '../hooks/useApiGet';
import { useApiList } from '../hooks/useApiList';
import { useApiMutation } from '../hooks/useApiMutation';
import { useClearFilters, useFilterParams } from '../hooks/useFilterParams';
import { formatCurrency, formatDate, todayIso } from '../utils/format';
import { BUDGET_CATEGORY_OPTIONS, budgetFields, categoryLabel } from './budgetFields';

const FILTER_NAMES = ['q', 'category', 'spent_from', 'spent_to'];
const FILTER_SPECS = [
  { name: 'category', label: 'Category', options: BUDGET_CATEGORY_OPTIONS },
  { name: 'spent_from', label: 'From', type: 'date' },
  { name: 'spent_to', label: 'To', type: 'date' },
];
const FIELDS = budgetFields();
const CLOSED = { open: false, record: null };

const COLUMNS = [
  { key: 'spent_on', label: 'Date', sortKey: 'spent_on', render: (entry) => formatDate(entry.spent_on) },
  {
    key: 'category',
    label: 'Category',
    sortKey: 'category',
    render: (entry) => categoryLabel(entry.category),
  },
  { key: 'description', label: 'Description' },
  {
    key: 'amount',
    label: 'Amount',
    sortKey: 'amount',
    align: 'right',
    render: (entry) => (
      <Typography variant="body2" component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatCurrency(entry.amount)}
      </Typography>
    ),
  },
];

function SummarySection({ summary }) {
  if (summary.error) {
    return (
      <Alert
        severity="error"
        action={(
          <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={summary.reload}>
            Retry
          </Button>
        )}
      >
        {`Could not load the budget summary. ${summary.error.message}`}
      </Alert>
    );
  }
  if (!summary.data) {
    return <Skeleton variant="rounded" height={160} aria-label="Loading budget summary" />;
  }
  return <BudgetSummary summary={summary.data} />;
}

SummarySection.propTypes = {
  summary: PropTypes.shape({
    data: PropTypes.object,
    error: PropTypes.shape({ message: PropTypes.string }),
    reload: PropTypes.func.isRequired,
  }).isRequired,
};

/**
 * A project's budget: the planned-versus-spent summary, then the spending entries with a
 * description search and category and date filters, and add, edit and delete as the role allows.
 *
 * @param {object} props Component props.
 * @param {{id: number}} props.project The project.
 * @param {() => void} props.onProjectChange Reloads the project header (spend changes).
 * @returns {JSX.Element} The tab.
 */
export default function BudgetTab({ project, onProjectChange }) {
  const { can } = useAuth();
  const canWrite = can('write');
  const canDelete = can('delete');
  const summary = useApiGet('/budgets/summary', { project_id: project.id });
  const filters = useFilterParams(FILTER_NAMES);
  const clearFilters = useClearFilters(FILTER_NAMES);
  const query = useMemo(() => ({ ...filters, project_id: project.id }), [filters, project.id]);
  const list = useApiList('/budgets', query, { columns: COLUMNS, defaultSort: '-spent_on' });
  const { create, update, remove, fetchOne } = useApiMutation('/budgets', {
    label: 'Budget entry', onStale: list.reload,
  });
  const [form, setForm] = useState(CLOSED);
  const [deletion, setDeletion] = useState(CLOSED);

  const editing = form.record;

  const afterChange = () => {
    list.reload();
    summary.reload();
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

  const describe = (entry) => `${formatCurrency(entry.amount)} ${categoryLabel(entry.category).toLowerCase()} entry from ${formatDate(entry.spent_on)}`;

  const rowActions = canWrite || canDelete
    ? (entry) => (
      <RowActions
        name={describe(entry)}
        onEdit={canWrite ? () => setForm({ open: true, record: entry }) : undefined}
        onDelete={canDelete ? () => setDeletion({ open: true, record: entry }) : undefined}
      />
    )
    : undefined;

  const hasFilters = FILTER_NAMES.some((name) => filters[name]);
  let emptyState;
  if (hasFilters) {
    emptyState = {
      title: 'No entries match these filters',
      message: 'Try another search, category or dates, or clear the filters to see every entry.',
      action: { label: 'Clear filters', onClick: clearFilters },
    };
  } else if (canWrite) {
    emptyState = {
      title: 'No spending recorded yet',
      message: 'Record what this project spends to compare it with the plan.',
      action: { label: 'Add entry', onClick: openCreate },
    };
  } else {
    emptyState = {
      title: 'No spending recorded yet',
      message: 'Entries appear here once a team lead or project manager records them.',
    };
  }

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 3 }}>
      <SummarySection summary={summary} />
      <Box component="section" aria-labelledby="budget-entries-heading">
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            mb: 2,
          }}
        >
          <Typography id="budget-entries-heading" variant="h6" component="h2">Entries</Typography>
          {canWrite && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
              Add entry
            </Button>
          )}
        </Box>
        <FilterBar
          ariaLabel="Filter budget entries"
          search={{ label: 'Search descriptions' }}
          filters={FILTER_SPECS}
        />
        <DataList
          ariaLabel="Budget entries"
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
      </Box>
      {canWrite && (
        <FormDialog
          open={form.open}
          title={editing ? 'Edit budget entry' : 'New budget entry'}
          fields={FIELDS}
          initialValues={editing ?? { spent_on: todayIso() }}
          changesOnly={Boolean(editing)}
          onReload={editing ? reloadEditing : undefined}
          onSubmit={handleSave}
          onClose={() => setForm((current) => ({ ...current, open: false }))}
          submitLabel={editing ? 'Save changes' : 'Add entry'}
        />
      )}
      {canDelete && (
        <ConfirmDialog
          open={deletion.open}
          title="Delete budget entry?"
          message={deletion.record ? `The ${describe(deletion.record)} will be permanently deleted.` : ''}
          confirmLabel="Delete entry"
          destructive
          onConfirm={handleDelete}
          onClose={() => setDeletion((current) => ({ ...current, open: false }))}
        />
      )}
    </Box>
  );
}

BudgetTab.propTypes = {
  project: PropTypes.shape({ id: PropTypes.number.isRequired }).isRequired,
  onProjectChange: PropTypes.func.isRequired,
};
