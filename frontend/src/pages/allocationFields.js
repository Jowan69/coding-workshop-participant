/**
 * The allocation form, with the same limits the API enforces (API.md, Allocations). The
 * project is fixed by the page, so it is not a field.
 *
 * @param {Array<{value: number, label: string}>} personOptions People to allocate.
 * @returns {object[]} FormDialog field specs.
 */
export function allocationFields(personOptions) {
  return [
    {
      name: 'resource_id',
      label: 'Person',
      type: 'autocomplete',
      options: personOptions,
      required: true,
    },
    { name: 'role_on_project', label: 'Role on project', type: 'text', maxLength: 100, half: true },
    {
      name: 'allocation_pct',
      label: 'Allocation (%)',
      type: 'number',
      required: true,
      min: 1,
      max: 100,
      decimals: 0,
      step: 5,
      half: true,
      helperText: 'Share of their working time, 1 to 100',
    },
    { name: 'start_date', label: 'Start date', type: 'date', required: true, half: true },
    {
      name: 'end_date',
      label: 'End date',
      type: 'date',
      required: true,
      half: true,
      validate: (value, values) => (
        values.start_date && value < values.start_date
          ? 'End date must be on or after the start date'
          : null
      ),
    },
  ];
}
