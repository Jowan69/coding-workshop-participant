import { ROLE_OPTIONS } from '../utils/permissions';

/**
 * The new-user form, with the same limits the API enforces (API.md, User fields).
 *
 * @returns {object[]} FormDialog field specs.
 */
export function userFields() {
  return [
    { name: 'full_name', label: 'Full name', type: 'text', required: true, maxLength: 120 },
    { name: 'email', label: 'Email', type: 'email', required: true, maxLength: 254 },
    {
      name: 'password',
      label: 'Temporary password',
      type: 'password',
      required: true,
      minLength: 8,
      maxLength: 128,
      half: true,
      helperText: '8 to 128 characters; share it with them securely',
    },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: ROLE_OPTIONS,
      defaultValue: 'viewer',
      half: true,
    },
  ];
}
