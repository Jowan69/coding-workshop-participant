import { MONEY_MAX } from '../utils/format';
import { PROJECT_STATUS_OPTIONS } from '../utils/status';

/**
 * Whether a project's deadline has passed while it is still open. The API decides, with the
 * database's date (`is_overdue`, judged on `as_of`); the browser's clock is never consulted.
 *
 * @param {{is_overdue?: boolean}} project Project from the API.
 * @returns {boolean} True when overdue.
 */
export function isProjectOverdue(project) {
  return project.is_overdue === true;
}

/**
 * Owner picker options: the active users, always including the signed-in user (the default
 * owner of a new project) and the current owner of the project being edited, even if that
 * person has since been deactivated.
 *
 * @param {Array<{id: number, full_name: string}>} [users] `/auth/users/options` items.
 * @param {{id: number, full_name: string}|null} [me] The signed-in user.
 * @param {{owner_id?: number|null, owner_name?: string|null}|null} [project] Project in the form.
 * @returns {Array<{value: number, label: string}>} Options, by name.
 */
export function ownerOptions(users = [], me = null, project = null) {
  const byId = new Map();
  const add = (id, name) => {
    if (Number.isInteger(id) && typeof name === 'string' && name && !byId.has(id)) byId.set(id, name);
  };
  (Array.isArray(users) ? users : []).forEach((item) => add(item?.id, item?.full_name));
  add(me?.id, me?.full_name);
  add(project?.owner_id, project?.owner_name);
  return [...byId]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The project form, with the same limits the API enforces (API.md, Projects).
 *
 * @param {string[]} [departments] Known departments, suggested while typing.
 * @param {Array<{value: number, label: string}>} [owners] People who can own the project.
 * @returns {object[]} FormDialog field specs.
 */
export function projectFields(departments = [], owners = []) {
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
      max: MONEY_MAX,
      decimals: 2,
      defaultValue: 0,
      half: true,
    },
    {
      name: 'owner_id',
      label: 'Owner',
      type: 'autocomplete',
      options: owners,
      half: true,
      helperText: 'Who answers for the project',
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
