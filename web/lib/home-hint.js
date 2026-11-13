// When to suggest "Add to Home Screen": iPhone or iPad browsers have no install prompt, so the site offers a one-line
// hint instead. Never inside the installed app, never in Chat (its own Install button sits in the header and the hint
// would cover the composer), and not again for 30 days after it is closed.
export const HINT_KEY = 'trellis-home-hint';
export const HINT_DELAY_MS = 6000;
const QUIET_MS = 30 * 86_400_000;

export function shouldHint({ ios, installed, path = '/', dismissedAt = null, now = Date.now() }) {
  if (!ios || installed) return false;
  if (/^\/harness(\/|$)/.test(path)) return false;
  const at = Number(dismissedAt);
  return !(at > 0 && now - at < QUIET_MS);
}
