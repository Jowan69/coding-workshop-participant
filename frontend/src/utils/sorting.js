/**
 * Sorting helpers for lists. A sort value is what the API's `sort` parameter takes: a column
 * name, with a leading "-" for descending, e.g. "end_date" or "-end_date".
 */

/**
 * Split a sort value into its column and direction.
 *
 * @param {string} [value] Sort value.
 * @returns {{key: string, direction: 'asc'|'desc'}} Column and direction.
 */
export function parseSort(value = '') {
  const descending = value.startsWith('-');
  return { key: descending ? value.slice(1) : value, direction: descending ? 'desc' : 'asc' };
}

/**
 * The sort a column header gives when clicked: ascending first, then the other direction.
 *
 * @param {string} current The sort in effect.
 * @param {string} key The clicked column's sort key.
 * @returns {string} The next sort value.
 */
export function nextSort(current, key) {
  return current === key ? `-${key}` : key;
}

/**
 * Sort choices for the phone layout's Sort select: every sortable column in both directions.
 *
 * @param {Array<{label: string, sortKey?: string}>} columns List columns.
 * @returns {Array<{value: string, label: string}>} Options.
 */
export function sortOptions(columns) {
  return columns.filter((column) => column.sortKey).flatMap((column) => [
    { value: column.sortKey, label: `${column.label}, ascending` },
    { value: `-${column.sortKey}`, label: `${column.label}, descending` },
  ]);
}
