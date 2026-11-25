export { ACTIVE_FILTER_OPTIONS } from '../utils/status';

/**
 * The person (resource) form, with the same limits the API enforces (API.md, Resources).
 *
 * @param {string[]} [departments] Known departments, suggested while typing.
 * @returns {object[]} FormDialog field specs.
 */
export function resourceFields(departments = []) {
  return [
    { name: 'full_name', label: 'Full name', type: 'text', required: true, maxLength: 120 },
    { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254 },
    { name: 'job_title', label: 'Job title', type: 'text', maxLength: 120, half: true },
    {
      name: 'department',
      label: 'Department',
      type: 'autocomplete',
      freeSolo: true,
      options: departments,
      maxLength: 100,
      half: true,
    },
    {
      name: 'capacity_pct',
      label: 'Capacity (%)',
      type: 'number',
      required: true,
      min: 1,
      max: 100,
      decimals: 0,
      defaultValue: 100,
      half: true,
      helperText: 'Share of full time they can work',
    },
    {
      name: 'is_active',
      label: 'Status',
      type: 'select',
      required: true,
      options: [{ value: true, label: 'Active' }, { value: false, label: 'Inactive' }],
      defaultValue: true,
      half: true,
    },
  ];
}
