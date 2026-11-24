/** Roles from lowest to highest, as decided in CLAUDE.md. */
export const ROLES = ['viewer', 'contributor', 'manager', 'admin'];

/** The lowest role allowed to perform each UI action. */
export const MIN_ROLE = {
  read: 'viewer',
  write: 'contributor',
  delete: 'manager',
  manageUsers: 'admin',
};

/** Human labels for the role chip and forms. */
export const ROLE_LABELS = {
  viewer: 'Viewer',
  contributor: 'Contributor',
  manager: 'Manager',
  admin: 'Admin',
};

/** Roles as select options, lowest first. */
export const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }));

/**
 * Whether a role may perform an action. The backend enforces the same ranking on every request;
 * this only decides what the UI renders.
 *
 * @param {string|null|undefined} role One of ROLES.
 * @param {'read'|'write'|'delete'|'manageUsers'} action The action to check.
 * @returns {boolean} True when the role ranks at or above the action's minimum role.
 */
export function canRole(role, action) {
  const rank = ROLES.indexOf(role);
  const needed = ROLES.indexOf(MIN_ROLE[action]);
  return rank >= 0 && needed >= 0 && rank >= needed;
}
