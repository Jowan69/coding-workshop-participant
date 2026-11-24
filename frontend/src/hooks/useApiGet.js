import { useCallback, useEffect, useState } from 'react';
import { request } from '../services/apiClient';

const NO_RESULT = { key: null, data: null, error: null };

/**
 * Load one API response, e.g. `/projects/3` or `/budgets/summary?project_id=3`.
 *
 * `loading` is derived from whether the latest result belongs to the current request, so a
 * slow, stale response can never overwrite a newer one. While a reload is in flight the
 * previous data stays available, so a page can refresh without flashing a skeleton.
 *
 * @param {string|null} path Endpoint under /api/tracker; null skips the request.
 * @param {Object<string, *>} [query] Query parameters; empty values are dropped by the client.
 * @returns {{data: *, loading: boolean, error: Error|null, reload: () => void}} Response state.
 */
export function useApiGet(path, query) {
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState(NO_RESULT);
  const requestKey = path ? JSON.stringify({ path, query: query ?? {}, reloadCount }) : null;

  useEffect(() => {
    if (!requestKey) return undefined;
    const { path: url, query: params } = JSON.parse(requestKey);
    const controller = new AbortController();
    request(url, { query: params, signal: controller.signal })
      .then((data) => setResult({ key: requestKey, data, error: null }))
      .catch((error) => {
        if (error?.name !== 'AbortError') setResult({ key: requestKey, data: null, error });
      });
    return () => controller.abort();
  }, [requestKey]);

  const loading = requestKey !== null && result.key !== requestKey;
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return {
    data: requestKey ? result.data : null,
    loading,
    error: loading || !requestKey ? null : result.error,
    reload,
  };
}
