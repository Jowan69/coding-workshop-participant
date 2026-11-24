import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Read filter values from the URL query, the state FilterBar writes. Missing params are ''.
 *
 * @param {string[]} names Param names; pass a module-level constant so the result is stable.
 * @returns {Object<string, string>} Current value per name.
 */
export function useFilterParams(names) {
  const [params] = useSearchParams();
  return useMemo(
    () => Object.fromEntries(names.map((name) => [name, params.get(name) ?? ''])),
    [names, params],
  );
}

/**
 * A callback that removes the given filter params from the URL, e.g. for an empty state's
 * "Clear filters" button. Other params (such as a tab) are kept.
 *
 * @param {string[]} names Param names; pass a module-level constant so the result is stable.
 * @returns {() => void} Clears the filters.
 */
export function useClearFilters(names) {
  const [, setParams] = useSearchParams();
  return useCallback(() => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      names.forEach((name) => next.delete(name));
      return next;
    }, { replace: true });
  }, [names, setParams]);
}
