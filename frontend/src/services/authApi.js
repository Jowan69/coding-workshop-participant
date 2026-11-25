import { request, storeTokens } from './apiClient';
import { clearSession, getSession } from './session';

/**
 * Sign out: ask the API to end every session of this user (POST /auth/logout), then forget
 * the tokens in this browser. The tokens are forgotten even when the call fails, so a person
 * can always sign out; an unreachable API only means the tokens stay valid elsewhere until
 * they expire.
 *
 * @returns {Promise<void>} Resolves once the session is cleared.
 */
export async function signOut() {
  try {
    if (getSession()?.accessToken) await request('/auth/logout', { method: 'POST' });
  } catch {
    // Signed out locally either way.
  } finally {
    clearSession();
  }
}

/**
 * Change the signed-in user's own password. The API revokes the old tokens and returns fresh
 * ones, which replace the session, so the user stays signed in.
 *
 * @param {string} currentPassword The password they signed in with.
 * @param {string} newPassword The replacement.
 * @returns {Promise<object>} The user.
 * @throws {ApiError} With field errors on `current_password` or `new_password`.
 */
export async function changePassword(currentPassword, newPassword) {
  const data = await request('/auth/change-password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
  });
  storeTokens(data);
  return data.user;
}
