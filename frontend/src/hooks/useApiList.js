import { useCallback, useState } from 'react';
import { useApiGet } from './useApiGet';
import { useDebouncedValue } from './useDebouncedValue';

function withoutEmpty(query) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

/**
 * Load a paginated API list, e.g. `/projects`, with filters and a debounced `q` search.
 *
 * Built on useApiGet, so a slow, stale response can never overwrite a newer one. The page
 * resets to the first one whenever the filters change.
 *
 * @param {string} path List endpoint under /api/tracker.
 * @param {Object<string, *>} [query] Filters; `q` is debounced, empty values are dropped.
 * @param {object} [options] Options.
 * @param {number} [options.initialRowsPerPage] First page size.
 * @returns {{items: object[], total: number, loading: boolean, error: Error|null,
 *   reload: () => void, page: number, rowsPerPage: number, setPage: (page: number) => void,
 *   setRowsPerPage: (size: number) => void}} List state and controls.
 */
export function useApiList(path, query = {}, { initialRowsPerPage = 10 } = {}) {
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPageState] = useState(initialRowsPerPage);

  const q = useDebouncedValue(query.q ?? '', 300);
  const filterKey = JSON.stringify(withoutEmpty({ ...query, q }));

  // Back to the first page when the filters change (adjusting state during render).
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(0);
  }

  const { data, loading, error, reload } = useApiGet(path, {
    ...JSON.parse(filterKey),
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
    setRowsPerPageState(size);
    setPage(0);
  }, []);

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
  };
}
