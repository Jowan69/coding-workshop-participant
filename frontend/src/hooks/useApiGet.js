import { useCallback, useEffect, useState } from 'react';
import { request } from '../services/apiClient';

const NO_RESULT = { key: null, base: null, data: null, error: null };

/**
 * Load one API response, e.g. `/projects/3` or `/budgets/summary?project_id=3`.
 *
 * `loading` is derived from whether the latest result belongs to the current request, so a
 * slow, stale response can never overwrite a newer one. While a reload is in flight the
 * previous data stays available, so a page can refresh without flashing a skeleton;
 * `refreshing` says the request in flight repeats the one whose data is on screen.
 *
 * @param {string|null} path Endpoint under /api/tracker; null skips the request.
 * @param {Object<string, *>} [query] Query parameters; empty values are dropped by the client.
 * @param {object} [options] Options.
 * @param {number} [options.refreshKey] Change it to load again, e.g. a page-wide refresh.
 * @param {() => void} [options.onLoaded] Called after each successful response; keep it stable.
 * @returns {{data: *, loading: boolean, refreshing: boolean, error: Error|null,
 *   reload: () => void}} Response state.
 */
export function useApiGet(path, query, { refreshKey = 0, onLoaded } = {}) {
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState(NO_RESULT);
  const baseKey = path ? JSON.stringify({ path, query: query ?? {} }) : null;
  const requestKey = baseKey ? `${baseKey}#${reloadCount}#${refreshKey}` : null;

  useEffect(() => {
    if (!requestKey) return undefined;
    const { path: url, query: params } = JSON.parse(baseKey);
    const controller = new AbortController();
    request(url, { query: params, signal: controller.signal })
      .then((data) => {
        setResult({ key: requestKey, base: baseKey, data, error: null });
        onLoaded?.();
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setResult({ key: requestKey, base: baseKey, data: null, error });
        }
      });
    return () => controller.abort();
  }, [requestKey, baseKey, onLoaded]);

  const loading = requestKey !== null && result.key !== requestKey;
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  return {
    data: requestKey ? result.data : null,
    loading,
    refreshing: loading && result.base === baseKey && result.data !== null,
    error: loading || !requestKey ? null : result.error,
    reload,
  };
}
