import { DELIVERABLE_STATUS_OPTIONS } from '../utils/status';

/**
 * Whether a deliverable is past its due date and not done. The API decides, with the
 * database's date (`is_overdue`, judged on `as_of`); the browser's clock is never consulted.
 *
 * @param {{is_overdue?: boolean}} deliverable Deliverable from the API.
 * @returns {boolean} True when overdue.
 */
export function isDeliverableOverdue(deliverable) {
  return deliverable.is_overdue === true;
}

/**
 * The deliverable form, with the same limits the API enforces (API.md, Deliverables).
 *
 * @param {Array<{value: number, label: string}>} assigneeOptions People to assign.
 * @returns {object[]} FormDialog field specs.
 */
export function deliverableFields(assigneeOptions) {
  return [
    { name: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: DELIVERABLE_STATUS_OPTIONS,
      defaultValue: 'not_started',
      half: true,
    },
    { name: 'due_date', label: 'Due date', type: 'date', required: true, half: true },
    {
      name: 'assignee_id',
      label: 'Assignee',
      type: 'autocomplete',
      options: assigneeOptions,
      helperText: 'Leave empty if nobody owns it yet',
    },
    { name: 'description', label: 'Description', type: 'text', multiline: true, maxLength: 2000 },
  ];
}
