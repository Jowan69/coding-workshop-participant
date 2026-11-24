import { useEffect, useState } from 'react';
import { request } from '../services/apiClient';

/**
 * Distinct departments of a collection (projects or resources), for the department filter and
 * form autocomplete. Department is free text and no endpoint lists the values, so this reads
 * the first 100 records (the API's page cap). If it fails the options are simply empty: they
 * are a convenience, not data.
 *
 * @param {'/projects'|'/resources'} path Collection whose `department` values to collect.
 * @param {number} [refreshKey] Change it to reload, e.g. after a record is saved.
 * @returns {string[]} Department names, sorted.
 */
export function useDepartments(path, refreshKey = 0) {
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    request(path, { query: { limit: 100 }, signal: controller.signal })
      .then((data) => {
        const names = new Set((data?.items ?? []).map((p) => p.department).filter(Boolean));
        setDepartments([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [path, refreshKey]);

  return departments;
}
