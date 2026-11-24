const EMPTY = '—';

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const currencyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/**
 * Parse an API date (`YYYY-MM-DD`) as a local calendar date, so it never shifts a day across
 * time zones the way `new Date('2026-01-31')` (UTC midnight) does.
 *
 * @param {string|null|undefined} value API date.
 * @returns {Date|null} Local midnight of that day, or null when missing or malformed.
 */
export function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Today's date as `YYYY-MM-DD` in local time.
 *
 * @param {Date} [now] Override for tests.
 * @returns {string} ISO calendar date.
 */
export function todayIso(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Format an API date for display, e.g. "Mar 4, 2026".
 *
 * @param {string|null|undefined} value API date.
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatDate(value) {
  const date = parseDate(value);
  return date ? dateFormat.format(date) : EMPTY;
}

/**
 * Format a money amount in whole US dollars, e.g. "$125,000".
 *
 * @param {number|string|null|undefined} value Amount.
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const number = Number(value);
  return Number.isFinite(number) ? currencyFormat.format(number) : EMPTY;
}

/**
 * Format a percentage with at most one decimal place, e.g. "42.5%".
 *
 * @param {number|null|undefined} value Percentage (0 to 100, may exceed 100).
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return EMPTY;
  return `${Math.round(Number(value) * 10) / 10}%`;
}
