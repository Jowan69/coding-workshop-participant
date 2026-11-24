/** Budget categories (API.md, Budgets) with their labels. */
const CATEGORY_LABELS = {
  labor: 'Labor',
  software: 'Software',
  hardware: 'Hardware',
  services: 'Services',
  other: 'Other',
};

/** Budget categories as select options. */
export const BUDGET_CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS)
  .map(([value, label]) => ({ value, label }));

/**
 * Human label for a budget category.
 *
 * @param {string} category API value, e.g. "labor".
 * @returns {string} Display label.
 */
export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * The budget entry form, with the same limits the API enforces. The project is fixed by the
 * page, so it is not a field.
 *
 * @returns {object[]} FormDialog field specs.
 */
export function budgetFields() {
  return [
    {
      name: 'category',
      label: 'Category',
      type: 'select',
      required: true,
      options: BUDGET_CATEGORY_OPTIONS,
      half: true,
    },
    {
      name: 'amount',
      label: 'Amount (USD)',
      type: 'number',
      required: true,
      decimals: 2,
      half: true,
      validate: (value) => (Number(value) > 0 ? null : 'Amount must be greater than 0'),
    },
    { name: 'spent_on', label: 'Date spent', type: 'date', required: true, half: true },
    { name: 'description', label: 'Description', type: 'text', multiline: true, maxLength: 500 },
  ];
}
