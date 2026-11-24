import { useEffect, useState } from 'react';
import { request } from '../services/apiClient';

/**
 * Distinct project departments, for the department filter and form autocomplete. Department is
 * free text and no endpoint lists the values, so this reads the first 100 projects (the API's
 * page cap). If it fails the options are simply empty: they are a convenience, not data.
 *
 * @param {number} [refreshKey] Change it to reload, e.g. after a project is saved.
 * @returns {string[]} Department names, sorted.
 */
export function useDepartments(refreshKey = 0) {
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    request('/projects', { query: { limit: 100 }, signal: controller.signal })
      .then((data) => {
        const names = new Set((data?.items ?? []).map((p) => p.department).filter(Boolean));
        setDepartments([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [refreshKey]);

  return departments;
}
