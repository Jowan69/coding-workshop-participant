import { useMemo } from 'react';
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
