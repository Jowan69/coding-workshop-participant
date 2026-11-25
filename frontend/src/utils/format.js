const EMPTY = '—';

/** The largest money amount the API stores: numeric(14, 2). */
export const MONEY_MAX = 999999999999.99;

/** The first and last calendar dates the API accepts (API.md, Formats). */
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2100-12-31';

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

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const centsFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
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
 * Format a moment as a 24-hour local time, e.g. "14:05".
 *
 * @param {Date|null|undefined} value The moment.
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatTime(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? timeFormat.format(value) : EMPTY;
}

/**
 * Format a money amount in US dollars: whole dollars when there are no cents ("$125,000"),
 * otherwise with cents ("$1,234.50"). The app's only currency formatter.
 *
 * @param {number|string|null|undefined} value Amount; may be negative (an overspend).
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY;
  const hasCents = Math.round(number * 100) % 100 !== 0;
  return (hasCents ? centsFormat : currencyFormat).format(number);
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

/**
 * Days until a deadline in words: "in 30 days", "today", "10 days overdue".
 *
 * @param {number|null|undefined} days Deadline minus today, negative once it has passed.
 * @returns {string} Display text, or an em dash when empty.
 */
export function formatDaysToDeadline(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return EMPTY;
  const count = Math.abs(Number(days));
  const unit = count === 1 ? 'day' : 'days';
  if (days > 0) return `in ${count} ${unit}`;
  if (days < 0) return `${count} ${unit} overdue`;
  return 'today';
}

/**
 * Whole days from one API date to another, e.g. how late a forecast is against a deadline.
 *
 * @param {string} from Earlier API date.
 * @param {string} to Later API date.
 * @returns {number|null} `to` minus `from` in days, or null when either is missing.
 */
export function daysBetween(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return null;
  // Round, because a daylight-saving change makes one day 23 or 25 hours long.
  return Math.round((end - start) / 86400000);
}
