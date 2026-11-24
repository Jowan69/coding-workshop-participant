import { useCallback, useEffect, useState } from 'react';
import { request } from '../services/apiClient';
import { useDebouncedValue } from './useDebouncedValue';

const EMPTY_RESULT = { key: null, items: [], total: 0, error: null };

function withoutEmpty(query) {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

/**
 * Load a paginated API list, e.g. `/projects`, with filters and a debounced `q` search.
 *
 * `loading` is derived from whether the latest result belongs to the current request, so a
 * slow, stale response can never overwrite a newer one. The page resets to the first one
 * whenever the filters change.
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
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState(EMPTY_RESULT);

  const q = useDebouncedValue(query.q ?? '', 300);
  const filterKey = JSON.stringify(withoutEmpty({ ...query, q }));

  // Back to the first page when the filters change (adjusting state during render).
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(0);
  }

  const requestKey = JSON.stringify({
    path,
    query: { ...JSON.parse(filterKey), limit: rowsPerPage, offset: page * rowsPerPage },
    reloadCount,
  });

  useEffect(() => {
    const { path: url, query: params } = JSON.parse(requestKey);
    const controller = new AbortController();
    request(url, { query: params, signal: controller.signal })
      .then((data) => setResult({
        key: requestKey,
        items: data?.items ?? [],
        total: data?.total ?? 0,
        error: null,
      }))
      .catch((error) => {
        if (error?.name !== 'AbortError') setResult({ ...EMPTY_RESULT, key: requestKey, error });
      });
    return () => controller.abort();
  }, [requestKey]);

  const loading = result.key !== requestKey;

  // A delete can empty the last page: step back to the new last page.
  if (!loading && !result.error && result.items.length === 0 && page > 0 && result.total > 0) {
    setPage(Math.max(0, Math.ceil(result.total / rowsPerPage) - 1));
  }

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const setRowsPerPage = useCallback((size) => {
    setRowsPerPageState(size);
    setPage(0);
  }, []);

  return {
    items: result.items,
    total: result.total,
    loading,
    error: loading ? null : result.error,
    reload,
    page,
    rowsPerPage,
    setPage,
    setRowsPerPage,
  };
}
