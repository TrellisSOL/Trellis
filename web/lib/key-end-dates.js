// Key end dates (update 16, `key-end-dates`): the end date field of the key dialog and the line on each key card.
// Pure (no React). The router holds the same bounds (src/api/key-end-dates.ts): a new key's end date in the future, any
// key's at most five years ahead; an existing key given a past end date ends at once.

const DAY = 86_400_000;
/** Five years, as the router counts them. */
export const KEY_END_MAX_MS = 5 * 365.25 * DAY;

const pad = n => String(n).padStart(2, '0');
/** An ISO time as the value of a datetime-local input, in the browser's own time zone ('' for none). */
export function toLocalInput(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The dialog's field to the API's `expires_at`: an ISO time, or null for no end date (an empty field). `{ error }` when
 * the router would refuse it.
 */
export function endDateFrom(value, { creating = false, now = Date.now() } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return { expires_at: null };
  const t = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) || !Number.isFinite(t)) return { error: 'Enter an end date and time, or leave it empty for no end date.' };
  if (creating && t <= now) return { error: 'A new key’s end date must be in the future.' };
  if (t - now > KEY_END_MAX_MS) return { error: 'An end date can be at most five years ahead.' };
  return { expires_at: new Date(t).toISOString() };
}

/** Whole days left before the end date, rounded up (0 or less once it has passed); null for a key with none. */
export function daysLeft(expiresAt, now = Date.now()) {
  const t = Date.parse(expiresAt || '');
  return Number.isFinite(t) ? Math.ceil((t - now) / DAY) : null;
}
export const ended = (expiresAt, now = Date.now()) => { const t = Date.parse(expiresAt || ''); return Number.isFinite(t) && t <= now; };

const when = t => new Date(t).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The key card's line: '' for no end date. */
export function endDateText(expiresAt, now = Date.now()) {
  const t = Date.parse(expiresAt || '');
  if (!Number.isFinite(t)) return '';
  if (t <= now) return `Ended ${when(t)}. Calls with this key are refused; set a later end date to use it again.`;
  const days = daysLeft(expiresAt, now);
  return t - now < DAY ? `Ends in less than a day · ${when(t)}` : `${days} day${days === 1 ? '' : 's'} left · ends ${when(t)}`;
}
