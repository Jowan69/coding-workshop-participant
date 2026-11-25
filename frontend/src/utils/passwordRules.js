/** Password length limits, the same as the API's policy (acme/core/passwords.py). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** The whole policy in one sentence, shown under every field that sets a password. */
export const PASSWORD_RULES = `${PASSWORD_MIN} to ${PASSWORD_MAX} characters, with at least one `
  + 'letter and one digit. Not the name or email name of the account, and not a common password.';

/**
 * The rules a browser can check before asking the API: length, a letter and a digit. The API
 * also refuses names and common passwords and says which rule failed.
 *
 * @param {string} value Candidate password, exactly as typed.
 * @param {string} [label] Field label for the message.
 * @returns {string|null} Error message, or null when these rules pass.
 */
export function passwordProblem(value, label = 'Password') {
  const text = String(value ?? '');
  if (text.length < PASSWORD_MIN) return `${label} must be at least ${PASSWORD_MIN} characters`;
  if (text.length > PASSWORD_MAX) return `${label} must be at most ${PASSWORD_MAX} characters`;
  if (!/\p{L}/u.test(text)) return `${label} must contain at least one letter`;
  if (!/\p{Nd}/u.test(text)) return `${label} must contain at least one digit`;
  return null;
}
