import { todayIso } from '../utils/format';
import { PROJECT_STATUS_OPTIONS } from '../utils/status';

/** Statuses after which a passed deadline no longer matters. */
const CLOSED_STATUSES = new Set(['completed', 'cancelled']);

/**
 * Whether a project's deadline has passed while it is still open.
 *
 * @param {{end_date: string, status: string}} project Project from the API.
 * @param {string} [today] `YYYY-MM-DD`, for tests.
 * @returns {boolean} True when overdue.
 */
export function isProjectOverdue(project, today = todayIso()) {
  return Boolean(project.end_date) && project.end_date < today && !CLOSED_STATUSES.has(project.status);
}

/**
 * The project form, with the same limits the API enforces (API.md, Projects).
 *
 * @param {string[]} [departments] Known departments, suggested while typing.
 * @returns {object[]} FormDialog field specs.
 */
export function projectFields(departments = []) {
  return [
    { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 150 },
    {
      name: 'department',
      label: 'Department',
      type: 'autocomplete',
      freeSolo: true,
      options: departments,
      required: true,
      maxLength: 100,
      half: true,
    },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: PROJECT_STATUS_OPTIONS,
      defaultValue: 'planned',
      half: true,
    },
    { name: 'start_date', label: 'Start date', type: 'date', required: true, half: true },
    {
      name: 'end_date',
      label: 'Deadline',
      type: 'date',
      required: true,
      half: true,
      validate: (value, values) => (
        values.start_date && value < values.start_date
          ? 'Deadline must be on or after the start date'
          : null
      ),
    },
    {
      name: 'budget_planned',
      label: 'Planned budget (USD)',
      type: 'number',
      required: true,
      min: 0,
      decimals: 2,
      defaultValue: 0,
      half: true,
    },
    {
      name: 'description',
      label: 'Description',
      type: 'text',
      multiline: true,
      maxLength: 2000,
    },
  ];
}
