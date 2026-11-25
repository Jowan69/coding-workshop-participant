import PropTypes from 'prop-types';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ROWS_PER_PAGE_OPTIONS } from '../hooks/useApiList';
import { useIsDesktop } from '../hooks/useIsDesktop';
import { nextSort, parseSort } from '../utils/sorting';

const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [role="menuitem"]';

function cellContent(column, row) {
  if (column.render) return column.render(row);
  const value = row[column.key];
  return value === null || value === undefined || value === '' ? '—' : value;
}

function PrimaryCell({ column, row, href }) {
  const content = cellContent(column, row);
  if (!href) return content;
  return (
    <Link component={RouterLink} to={href} underline="hover" sx={{ fontWeight: 600 }}>
      {content}
    </Link>
  );
}

PrimaryCell.propTypes = {
  column: PropTypes.object.isRequired,
  row: PropTypes.object.isRequired,
  href: PropTypes.string,
};

function ErrorState({ error, onRetry, ariaLabel }) {
  return (
    <Alert
      severity="error"
      action={onRetry && (
        <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={onRetry}>
          Retry
        </Button>
      )}
    >
      <AlertTitle>{`Could not load ${ariaLabel.toLowerCase()}`}</AlertTitle>
      {error.message}
    </Alert>
  );
}

ErrorState.propTypes = {
  error: PropTypes.shape({ message: PropTypes.string }).isRequired,
  onRetry: PropTypes.func,
  ariaLabel: PropTypes.string.isRequired,
};

function EmptyState({ title, message, action }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}>
      <InboxOutlinedIcon aria-hidden="true" sx={{ fontSize: 48, color: 'text.secondary' }} />
      <Typography variant="h6" component="h2" sx={{ mt: 1 }}>{title}</Typography>
      {message && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{message}</Typography>
      )}
      {action && (
        <Button variant="contained" onClick={action.onClick} sx={{ mt: 2 }}>{action.label}</Button>
      )}
    </Paper>
  );
}

EmptyState.propTypes = {
  title: PropTypes.string.isRequired,
  message: PropTypes.string,
  action: PropTypes.shape({ label: PropTypes.string.isRequired, onClick: PropTypes.func.isRequired }),
};

function HeaderCell({ column, sort, onSortChange }) {
  if (!column.sortKey || !onSortChange) {
    return <TableCell align={column.align} scope="col">{column.label}</TableCell>;
  }
  const current = parseSort(sort);
  const active = current.key === column.sortKey;
  return (
    // sortDirection sets aria-sort, so assistive technology hears which column sorts the list.
    <TableCell align={column.align} scope="col" sortDirection={active ? current.direction : false}>
      <TableSortLabel
        active={active}
        direction={active ? current.direction : 'asc'}
        onClick={() => onSortChange(nextSort(sort, column.sortKey))}
      >
        {column.label}
      </TableSortLabel>
    </TableCell>
  );
}

HeaderCell.propTypes = {
  column: PropTypes.object.isRequired,
  sort: PropTypes.string,
  onSortChange: PropTypes.func,
};

function DesktopTable({
  columns, rows, getRowId, getRowHref, rowActions, showSkeleton, skeletonRows, ariaLabel, sort, onSortChange,
}) {
  const navigate = useNavigate();

  const handleRowClick = (event, href) => {
    // Ignore clicks on links and buttons in the row, and clicks bubbling from portals (dialogs).
    if (!event.currentTarget.contains(event.target) || event.target.closest(INTERACTIVE)) return;
    navigate(href);
  };

  return (
    <Table aria-label={ariaLabel} aria-busy={showSkeleton || undefined}>
      <TableHead>
        <TableRow>
          {columns.map((column) => (
            <HeaderCell key={column.key} column={column} sort={sort} onSortChange={onSortChange} />
          ))}
          {rowActions && <TableCell align="right" scope="col">Actions</TableCell>}
        </TableRow>
      </TableHead>
      <TableBody>
        {showSkeleton && Array.from({ length: skeletonRows }, (_, index) => (
          <TableRow key={`skeleton-${index}`} data-testid="skeleton-row">
            {columns.map((column) => (
              <TableCell key={column.key}><Skeleton variant="text" /></TableCell>
            ))}
            {rowActions && <TableCell><Skeleton variant="text" /></TableCell>}
          </TableRow>
        ))}
        {!showSkeleton && rows.map((row) => {
          const href = getRowHref?.(row);
          return (
            <TableRow
              key={getRowId(row)}
              hover
              onClick={href ? (event) => handleRowClick(event, href) : undefined}
              sx={{ cursor: href ? 'pointer' : 'default' }}
            >
              {columns.map((column, index) => (
                <TableCell key={column.key} align={column.align}>
                  {index === 0
                    ? <PrimaryCell column={column} row={row} href={href} />
                    : cellContent(column, row)}
                </TableCell>
              ))}
              {rowActions && (
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{rowActions(row)}</TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

DesktopTable.propTypes = {
  columns: PropTypes.array.isRequired,
  rows: PropTypes.array.isRequired,
  getRowId: PropTypes.func.isRequired,
  getRowHref: PropTypes.func,
  rowActions: PropTypes.func,
  showSkeleton: PropTypes.bool.isRequired,
  skeletonRows: PropTypes.number.isRequired,
  ariaLabel: PropTypes.string.isRequired,
  sort: PropTypes.string,
  onSortChange: PropTypes.func,
};

function MobileCards({ columns, rows, getRowId, getRowHref, rowActions, showSkeleton, skeletonRows, ariaLabel }) {
  const [primary, ...details] = columns;
  return (
    <Box
      component="ul"
      aria-label={ariaLabel}
      aria-busy={showSkeleton || undefined}
      // minmax(0, 1fr) and min-width 0: a card never grows with a long unbroken value.
      sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1.5 }}
    >
      {showSkeleton && Array.from({ length: Math.min(skeletonRows, 3) }, (_, index) => (
        <Box component="li" key={`skeleton-${index}`} data-testid="skeleton-row">
          <Card variant="outlined">
            <CardContent>
              <Skeleton variant="text" width="60%" />
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </CardContent>
          </Card>
        </Box>
      ))}
      {!showSkeleton && rows.map((row) => (
        <Box component="li" key={getRowId(row)} sx={{ minWidth: 0 }}>
          <Card variant="outlined">
            <CardContent sx={{ pb: rowActions ? 1 : 2 }}>
              <Typography
                variant="subtitle1"
                component="h3"
                sx={{ fontWeight: 600, mb: 1, overflowWrap: 'anywhere' }}
              >
                <PrimaryCell column={primary} row={row} href={getRowHref?.(row)} />
              </Typography>
              <Box
                component="dl"
                sx={{
                  m: 0,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(96px, auto) minmax(0, 1fr)',
                  columnGap: 2,
                  rowGap: 1,
                  alignItems: 'center',
                }}
              >
                {details.map((column) => (
                  <Box key={column.key} sx={{ display: 'contents' }}>
                    <Typography component="dt" variant="body2" color="text.secondary">
                      {column.label}
                    </Typography>
                    <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
                      {cellContent(column, row)}
                    </Box>
                  </Box>
                ))}
              </Box>
            </CardContent>
            {rowActions && (
              <CardActions sx={{ justifyContent: 'flex-end', flexWrap: 'wrap', pt: 0 }}>
                {rowActions(row)}
              </CardActions>
            )}
          </Card>
        </Box>
      ))}
    </Box>
  );
}

MobileCards.propTypes = DesktopTable.propTypes;

/**
 * A list of records: a table on desktop, stacked cards on phones. Handles loading (skeletons
 * first time, a thin bar on refresh), empty, error-with-retry, pagination and sorting: column
 * headers that sort (with `aria-sort`) on desktop, a Sort select above the cards on phones.
 *
 * @param {object} props Component props.
 * @param {Array<{key: string, label: string, render?: Function, align?: string,
 *   sortKey?: string}>} props.columns Columns; the first is the row's title and links to
 *   `getRowHref(row)`. `sortKey` is the API sort column behind a sortable column.
 * @param {string} [props.sort] The sort in effect, e.g. "name" or "-end_date".
 * @param {(sort: string) => void} [props.onSortChange] Enables the sort controls.
 * @param {Array<{value: string, label: string}>} [props.sortChoices] The Sort select's
 *   options on phones (useApiList's `sortChoices`).
 * @param {object[]} props.rows Records for the current page.
 * @param {(row: object) => (string|number)} [props.getRowId] Unique key, `row.id` by default.
 * @param {boolean} [props.loading] A request is in flight.
 * @param {Error|null} [props.error] The last request failed.
 * @param {() => void} [props.onRetry] Retry after an error.
 * @param {number} [props.total] Total matching records, for pagination.
 * @param {number} [props.page] Zero-based page.
 * @param {number} [props.rowsPerPage] Page size.
 * @param {(page: number) => void} [props.onPageChange] Enables pagination.
 * @param {(size: number) => void} [props.onRowsPerPageChange] Page size changed.
 * @param {(row: object) => string} [props.getRowHref] Route a row opens.
 * @param {(row: object) => React.ReactNode} [props.rowActions] Buttons for a row.
 * @param {{title: string, message?: string, action?: {label: string, onClick: Function}}}
 *   props.emptyState What to show with no rows.
 * @param {string} props.ariaLabel Accessible name, e.g. "Projects".
 * @returns {JSX.Element} The list.
 */
export default function DataList({
  columns,
  rows,
  getRowId = (row) => row.id,
  loading = false,
  error = null,
  onRetry,
  total = 0,
  page = 0,
  rowsPerPage = 10,
  onPageChange,
  onRowsPerPageChange,
  rowsPerPageOptions = ROWS_PER_PAGE_OPTIONS,
  getRowHref,
  rowActions,
  emptyState,
  ariaLabel,
  skeletonRows = 5,
  sort = '',
  onSortChange,
  sortChoices = [],
}) {
  const isDesktop = useIsDesktop();

  if (error && !loading) {
    return <ErrorState error={error} onRetry={onRetry} ariaLabel={ariaLabel} />;
  }
  if (!loading && rows.length === 0) {
    return <EmptyState {...emptyState} />;
  }

  const showSkeleton = loading && rows.length === 0;
  const refreshing = loading && rows.length > 0;
  const bodyProps = {
    columns, rows, getRowId, getRowHref, rowActions, showSkeleton, skeletonRows, ariaLabel,
  };
  const body = isDesktop
    ? <DesktopTable {...bodyProps} sort={sort} onSortChange={onSortChange} />
    : <MobileCards {...bodyProps} />;
  const showSortSelect = !isDesktop && Boolean(onSortChange) && sortChoices.length > 0;

  return (
    <Box sx={{ position: 'relative', minWidth: 0 }}>
      {refreshing && (
        <LinearProgress
          aria-label={`Refreshing ${ariaLabel.toLowerCase()}`}
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, zIndex: 1 }}
        />
      )}
      {showSortSelect && (
        <TextField
          select
          size="small"
          fullWidth
          label="Sort"
          value={sortChoices.some((choice) => choice.value === sort) ? sort : ''}
          onChange={(event) => onSortChange(event.target.value)}
          sx={{ mb: 1.5 }}
        >
          {sortChoices.map((choice) => (
            <MenuItem key={choice.value} value={choice.value}>{choice.label}</MenuItem>
          ))}
        </TextField>
      )}
      {isDesktop ? (
        <TableContainer component={Paper} variant="outlined">{body}</TableContainer>
      ) : body}
      {onPageChange && !showSkeleton && (
        <TablePagination
          component="div"
          count={total}
          page={page}
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={rowsPerPageOptions}
          onPageChange={(event, next) => onPageChange(next)}
          onRowsPerPageChange={(event) => onRowsPerPageChange?.(Number(event.target.value))}
          labelRowsPerPage={isDesktop ? 'Rows per page:' : 'Per page:'}
        />
      )}
    </Box>
  );
}

DataList.propTypes = {
  columns: PropTypes.arrayOf(PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    render: PropTypes.func,
    align: PropTypes.oneOf(['left', 'right', 'center']),
    sortKey: PropTypes.string,
  })).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  getRowId: PropTypes.func,
  loading: PropTypes.bool,
  error: PropTypes.shape({ message: PropTypes.string }),
  onRetry: PropTypes.func,
  total: PropTypes.number,
  page: PropTypes.number,
  rowsPerPage: PropTypes.number,
  onPageChange: PropTypes.func,
  onRowsPerPageChange: PropTypes.func,
  rowsPerPageOptions: PropTypes.arrayOf(PropTypes.number),
  getRowHref: PropTypes.func,
  rowActions: PropTypes.func,
  emptyState: PropTypes.shape({
    title: PropTypes.string.isRequired,
    message: PropTypes.string,
    action: PropTypes.shape({ label: PropTypes.string.isRequired, onClick: PropTypes.func.isRequired }),
  }).isRequired,
  ariaLabel: PropTypes.string.isRequired,
  skeletonRows: PropTypes.number,
  sort: PropTypes.string,
  onSortChange: PropTypes.func,
  sortChoices: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
  })),
};
