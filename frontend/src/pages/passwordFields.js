import { PASSWORD_MAX, PASSWORD_RULES, passwordProblem } from '../utils/passwordRules';

/**
 * The change-your-own-password form: the current password, the new one with the policy under
 * it, and the new one again (checked here, never sent).
 *
 * @param {string} [currentLabel] Label of the first field, e.g. "Temporary password".
 * @returns {object[]} FormDialog field specs.
 */
export function changePasswordFields(currentLabel = 'Current password') {
  return [
    {
      name: 'current_password',
      label: currentLabel,
      type: 'password',
      required: true,
      maxLength: PASSWORD_MAX,
      autoComplete: 'current-password',
    },
    {
      name: 'new_password',
      label: 'New password',
      type: 'password',
      required: true,
      maxLength: PASSWORD_MAX,
      helperText: PASSWORD_RULES,
      validate: (value, values) => passwordProblem(value, 'New password')
        ?? (value === values.current_password
          ? 'New password must be different from your current password' : null),
    },
    {
      name: 'repeat_password',
      label: 'Repeat new password',
      type: 'password',
      required: true,
      maxLength: PASSWORD_MAX,
      validate: (value, values) => (
        value === values.new_password ? null : 'The two new passwords do not match'
      ),
    },
  ];
}

/**
 * The admin's reset form: one temporary password, with the policy under it.
 *
 * @returns {object[]} FormDialog field specs.
 */
export function resetPasswordFields() {
  return [
    {
      name: 'password',
      label: 'Temporary password',
      type: 'password',
      required: true,
      maxLength: PASSWORD_MAX,
      helperText: PASSWORD_RULES,
      validate: (value) => passwordProblem(value, 'Temporary password'),
    },
  ];
}
