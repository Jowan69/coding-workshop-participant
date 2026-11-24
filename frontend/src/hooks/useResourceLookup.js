import { useMemo } from 'react';
import { useApiList } from './useApiList';

const NO_FILTERS = {};

/**
 * People (resources) for pickers and for showing names where the API returns only an id, such
 * as a deliverable's assignee or an allocation's person. Reads the first 100 by name (the
 * API's page cap); anyone beyond that shows as "Person #id".
 *
 * @returns {{resources: object[], nameOf: (id: number|null) => string|null,
 *   optionsFor: (currentId?: number|null) => Array<{value: number, label: string}>}}
 *   The people, a name lookup and picker options.
 */
export function useResourceLookup() {
  const { items } = useApiList('/resources', NO_FILTERS, { initialRowsPerPage: 100 });

  return useMemo(() => {
    const byId = new Map(items.map((person) => [person.id, person]));
    const nameOf = (id) => {
      if (id === null || id === undefined) return null;
      return byId.get(id)?.full_name ?? `Person #${id}`;
    };
    // Active people, plus the current choice even if they have since been deactivated.
    const optionsFor = (currentId = null) => items
      .filter((person) => person.is_active || person.id === currentId)
      .map((person) => ({
        value: person.id,
        label: person.is_active ? person.full_name : `${person.full_name} (inactive)`,
      }));
    return { resources: items, nameOf, optionsFor };
  }, [items]);
}
