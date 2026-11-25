import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN, PASSWORD_RULES, passwordProblem } from './passwordRules';

describe('passwordProblem', () => {
  it.each([
    ['Short-1', 'Password must be at least 10 characters'],
    ['a1'.repeat(65), 'Password must be at most 128 characters'],
    ['1234567890-!', 'Password must contain at least one letter'],
    ['no-digits-here', 'Password must contain at least one digit'],
  ])('refuses %s', (value, message) => {
    expect(passwordProblem(value)).toBe(message);
  });

  it.each(['Tangerine-Sky-42', 'a'.repeat(9) + '1', 'A1'.repeat(64), 'pässwörter-2026'])('accepts %s', (value) => {
    expect(passwordProblem(value)).toBeNull();
  });

  it('uses the field label in the message', () => {
    expect(passwordProblem('x', 'New password')).toBe('New password must be at least 10 characters');
  });

  it('states the same limits as the API policy', () => {
    expect([PASSWORD_MIN, PASSWORD_MAX]).toEqual([10, 128]);
    expect(PASSWORD_RULES).toMatch(/^10 to 128 characters, with at least one letter and one digit\./);
    expect(PASSWORD_RULES).toMatch(/common password/);
  });
});
