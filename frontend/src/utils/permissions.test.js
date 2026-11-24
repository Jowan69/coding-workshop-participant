import { describe, expect, it } from 'vitest';
import { canRole } from './permissions';

const MATRIX = {
  viewer: { read: true, write: false, delete: false, manageUsers: false },
  contributor: { read: true, write: true, delete: false, manageUsers: false },
  manager: { read: true, write: true, delete: true, manageUsers: false },
  admin: { read: true, write: true, delete: true, manageUsers: true },
};

const cases = Object.entries(MATRIX).flatMap(([role, actions]) => (
  Object.entries(actions).map(([action, allowed]) => [role, action, allowed])
));

describe('canRole', () => {
  it.each(cases)('%s can %s: %s', (role, action, allowed) => {
    expect(canRole(role, action)).toBe(allowed);
  });

  it('denies everything without a known role', () => {
    expect(canRole(null, 'read')).toBe(false);
    expect(canRole(undefined, 'read')).toBe(false);
    expect(canRole('superuser', 'read')).toBe(false);
  });

  it('denies unknown actions', () => {
    expect(canRole('admin', 'launch')).toBe(false);
  });
});
