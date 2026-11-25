/** What the UI says when the API answers 409 stale_record. */
export const STALE_MESSAGE = 'This was changed by someone else';

/**
 * Add `expected_updated_at` to an update's body, so the API can refuse it (409 stale_record)
 * if the record has changed since this copy was loaded.
 *
 * @param {{updated_at?: string}|null|undefined} record The copy the user is looking at.
 * @param {object} body The fields to change.
 * @returns {object} The body, with the record's `updated_at` when it has one.
 */
export function expecting(record, body) {
  return record?.updated_at ? { ...body, expected_updated_at: record.updated_at } : body;
}
