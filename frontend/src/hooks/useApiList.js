import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sortOptions } from '../utils/sorting';
import { useApiGet } from './useApiGet';
import { useDebouncedValue } from './useDebouncedValue';

/** Page sizes a list offers; `per_page` in the URL must be one of these. */
export const ROWS_PER_PAGE_OPTIONS = [10, 25, 50];
const DEFAULT_ROWS = ROWS_PER_PAGE_OPTIONS[0];

function withoutEmpty(query) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

/** A positive whole number from the URL, or the fallback. */
function wholeNumber(text, fallback) {
  return /^[1-9]\d{0,6}$/.test(text ?? '') ? Number(text) : fallback;
}

/**
 * Load a paginated API list, e.g. `/projects`, with filters and a debounced `q` search.
 *
 * Built on useApiGet, so a slow, stale response can never overwrite a newer one.
 *
 * With `columns` the list's page, page size and sort live in the URL query (`page`, counted
 * from 1, `per_page` and `sort`), next to the filters FilterBar keeps there. A reload, a
 * shared link and the back button therefore restore the same view. Values that are not
 * valid (an unknown sort, a page size the list does not offer) are ignored. FilterBar drops
 * `page` whenever a filter changes. Without `columns` the state is local to the component,
 * for lists that are not the page's main list (pickers, lookups).
 *
 * @param {string} path List endpoint under /api/tracker.
 * @param {Object<string, *>} [query] Filters; `q` is debounced, empty values are dropped.
 * @param {object} [options] Options.
 * @param {number} [options.initialRowsPerPage] Page size for a list without URL state.
 * @param {Array<{label: string, sortKey?: string}>} [options.columns] The list's columns:
 *   keeps page, page size and sort in the URL; `sortKey` marks the sortable ones.
 * @param {string} [options.defaultSort] The API's default sort for this list, shown as the
 *   sort in effect until the user picks one.
 * @returns {{items: object[], total: number, loading: boolean, error: Error|null,
 *   reload: () => void, page: number, rowsPerPage: number, setPage: (page: number) => void,
 *   setRowsPerPage: (size: number) => void, sort: string, setSort: (sort: string) => void,
 *   sortChoices: Array<{value: string, label: string}>}} List state and controls.
 */
export function useApiList(path, query = {}, { initialRowsPerPage = DEFAULT_ROWS, columns, defaultSort = '' } = {}) {
  const inUrl = Boolean(columns);
  const [params, setParams] = useSearchParams();
  const [localPage, setLocalPage] = useState(0);
  const [localRows, setLocalRows] = useState(initialRowsPerPage);
  const sortChoices = useMemo(() => sortOptions(columns ?? []), [columns]);

  const urlRows = wholeNumber(params.get('per_page'), DEFAULT_ROWS);
  const urlSort = params.get('sort') ?? '';
  const page = inUrl ? wholeNumber(params.get('page'), 1) - 1 : localPage;
  const rowsPerPage = inUrl
    ? (ROWS_PER_PAGE_OPTIONS.includes(urlRows) ? urlRows : DEFAULT_ROWS)
    : localRows;
  const chosenSort = inUrl && sortChoices.some((choice) => choice.value === urlSort) ? urlSort : '';

  const q = useDebouncedValue(query.q ?? '', 300);
  const filterKey = JSON.stringify(withoutEmpty({ ...query, q }));

  const updateUrl = useCallback((changes) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      Object.entries(changes).forEach(([name, value]) => {
        if (value) next.set(name, String(value));
        else next.delete(name);
      });
      return next;
    }, { replace: true });
  }, [setParams]);

  const setPage = useCallback((next) => {
    if (inUrl) updateUrl({ page: next > 0 ? next + 1 : '' });
    else setLocalPage(next);
  }, [inUrl, updateUrl]);

  // Without URL state: back to the first page when the filters change (adjusting state
  // during render). With it, FilterBar removes `page` as it writes the filter.
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    if (!inUrl) setLocalPage(0);
  }

  const { data, loading, error, reload } = useApiGet(path, {
    ...JSON.parse(filterKey),
    ...(chosenSort ? { sort: chosenSort } : {}),
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // A delete can empty the last page: step back to the new last page.
  if (!loading && !error && items.length === 0 && page > 0 && total > 0) {
    setPage(Math.max(0, Math.ceil(total / rowsPerPage) - 1));
  }

  const setRowsPerPage = useCallback((size) => {
    if (inUrl) updateUrl({ per_page: size === DEFAULT_ROWS ? '' : size, page: '' });
    else {
      setLocalRows(size);
      setLocalPage(0);
    }
  }, [inUrl, updateUrl]);

  const setSort = useCallback((value) => {
    updateUrl({ sort: value === defaultSort ? '' : value, page: '' });
  }, [defaultSort, updateUrl]);

  return {
    items,
    total,
    loading,
    error,
    reload,
    page,
    rowsPerPage,
    setPage,
    setRowsPerPage,
    sort: chosenSort || defaultSort,
    setSort,
    sortChoices,
  };
}
