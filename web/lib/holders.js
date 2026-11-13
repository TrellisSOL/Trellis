// $TRLS holder tiers, as the site shows them. A tier is a membership level with a fixed threshold. Its perks are access
// and priority: higher limits, a place in the sealed-lane queue and in Bushel purchase ordering, earlier access to
// newly listed models, an advisory vote, credits that do not expire while the wallet holds the tier, and an opt-in
// profile badge. A tier does not change a price: every caller pays the host's price. Everything here describes what the
// router returns today (GET /api/v1/holders/tiers, /holders/me, /holders/polls) and can change.
import { walletAuthHeader } from './wallet.js';

export const TIERS_PATH = '/api/v1/holders/tiers';
export const ME_PATH = '/api/v1/holders/me';
export const POLLS_PATH = '/api/v1/holders/polls';
export const pollPath = id => `${POLLS_PATH}/${encodeURIComponent(id)}`;
export const votePath = id => `${pollPath(id)}/vote`;

export const NOT_ON = 'Holder tiers are not switched on yet';
export const CAN_CHANGE = 'This is how tiers work today. Thresholds and perks can change.';

/** True when the router runs tiers and has at least one to show. */
export const tiersOn = doc => !!doc?.enabled && Array.isArray(doc.tiers) && doc.tiers.length > 0;

/** A decimal token amount with thousands separators ("100000.5" -> "100,000.5"); anything else is returned as text. */
export function formatAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return text;
  const [whole, frac] = text.split('.');
  const trimmed = (frac || '').replace(/0+$/, '');
  return whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (trimmed ? '.' + trimmed : '');
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = v => (num(v) == null ? 'Standard' : num(v).toLocaleString('en-US'));
const times = v => (num(v) == null || v === 1 ? 'Standard' : `${v}×`);
const hours = v => (num(v) > 0 ? `${v} ${v === 1 ? 'hour' : 'hours'} early` : 'When the window ends');

export const TIER_COLUMNS = [
  { key: 'min', label: 'Threshold' },
  { key: 'rpm', label: 'Requests per minute' },
  { key: 'tpm', label: 'Tokens per minute' },
  { key: 'agent_keys', label: 'Agent keys' },
  { key: 'saved_routes', label: 'Saved routes' },
  { key: 'batch_rows', label: 'Batch rows' },
  { key: 'sealed', label: 'Sealed-lane queue' },
  { key: 'early', label: 'New models' },
  { key: 'vote', label: 'Vote weight' },
  { key: 'expiry', label: 'Credits expire' },
  { key: 'badge', label: 'Profile badge' },
];

/** One row of the tier table per tier, in the order the router lists them (lowest threshold first). */
export function tierRows(doc) {
  const symbol = doc?.token?.symbol || 'TRLS';
  return (Array.isArray(doc?.tiers) ? doc.tiers : []).map(t => ({
    name: String(t.name),
    cells: {
      min: `${formatAmount(t.min)} $${symbol}`,
      rpm: times(t.rpm_multiplier),
      tpm: times(t.tpm_multiplier),
      agent_keys: count(t.max_agent_keys),
      saved_routes: count(t.max_saved_routes),
      batch_rows: count(t.max_batch_rows),
      sealed: num(t.sealed_priority) > 0 ? `Priority ${t.sealed_priority}` : 'Standard',
      early: hours(t.early_access_hours),
      vote: num(t.vote_weight) > 0 ? String(t.vote_weight) : 'No vote',
      expiry: t.credits_never_expire ? 'Not while the tier is held' : 'As usual',
      badge: t.badge ? 'Optional' : 'None',
    },
  }));
}

const limit = v => (v === 0 ? 'no cap' : num(v) == null ? 'not set' : num(v).toLocaleString('en-US'));

/** The perks of a /holders/me document as plain lines. With no tier these are the standard limits every key has. */
export function perkLines(perks) {
  if (!perks) return [];
  const l = perks.limits || {};
  return [
    `Limits: ${limit(l.rpm)} requests and ${limit(l.tpm)} tokens per minute; ${limit(l.agent_keys)} agent keys; ${limit(l.saved_routes)} saved routes; ${limit(l.presets)} presets; ${limit(l.batch_rows)} batch rows.`,
    num(perks.sealed_priority) > 0
      ? `Sealed lane: priority ${perks.sealed_priority} when a host is full, and in Bushel purchase ordering. A share of capacity is kept for callers with no tier.`
      : 'Sealed lane: standard place in the queue.',
    num(perks.early_access_hours) > 0
      ? `New models: open to this wallet ${perks.early_access_hours} ${perks.early_access_hours === 1 ? 'hour' : 'hours'} before the early-access window ends.`
      : 'New models: open when the early-access window ends.',
    num(perks.vote_weight) > 0 ? `Advisory polls: one vote, counted with weight ${perks.vote_weight}.` : 'Advisory polls: no vote.',
    perks.credits_never_expire ? 'Credits: do not expire while this wallet holds the tier.' : 'Credits: the usual expiry rules apply.',
    perks.badge ? 'Profile badge: available, off until you switch it on for a public agent profile.' : 'Profile badge: not available.',
  ];
}

/** What stands between this wallet and the next tier, or null at the top tier (or when tiers are off). */
export function nextTierLine(me) {
  const next = me?.next_tier;
  if (!next) return null;
  const symbol = me?.token?.symbol || 'TRLS';
  return `Next tier: ${next.name}, from ${formatAmount(next.min)} $${symbol}. This wallet is ${formatAmount(next.remaining)} $${symbol} below that threshold.`;
}

/** The state of the "your tier" card: what to say before any perk is listed. */
export function tierStatus(me) {
  if (!me) return { state: 'signed-out', text: 'Sign in with the wallet that holds the token to see its tier.' };
  if (!me.enabled) return { state: 'off', text: NOT_ON + '.' };
  if (!me.wallet) return { state: 'no-wallet', text: me.hint || 'Holder tiers follow a wallet. Sign in with the wallet that holds the token.' };
  if (me.balance_error) return { state: 'unreadable', text: 'The token balance could not be read just now, so no tier applies. Try again shortly.' };
  if (!me.tier) return { state: 'none', text: 'This wallet is below the first threshold, so it has the standard limits.' };
  return { state: 'tier', text: `This wallet holds the ${me.tier.name} tier.` };
}

// ---- early access ---------------------------------------------------------------------------------------------------

const when = iso => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
/** "12 Oct 2026, 14:00 UTC": one fixed, zone-stated format so the same label reads the same everywhere. */
export function formatTime(iso) {
  const t = when(iso);
  if (t == null) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(new Date(t)) + ' UTC';
}

/** The label for a model's `early_access` field ({until, your_access_at}), or null when no window is running. */
export function earlyAccessLabel(model, now = Date.now()) {
  const window = model?.early_access;
  const until = when(window?.until);
  if (!window || until == null || until <= now) return null;
  const yours = when(window.your_access_at) ?? until;
  if (yours <= now) return { open: true, text: `Early access: open to you now. Opens to everyone ${formatTime(window.until)}.` };
  return { open: false, text: yours < until ? `Early access: opens to you ${formatTime(window.your_access_at)}, to everyone ${formatTime(window.until)}.` : `Early access: opens ${formatTime(window.until)}.` };
}

/** A plain sentence for the 403 a call to a model still in early access gets; null for any other error. */
export function earlyAccessMessage(error) {
  if (!error || error.type !== 'early_access') return null;
  const m = error.metadata || {};
  const model = typeof m.model === 'string' && m.model ? m.model : 'This model';
  const opens = formatTime(m.opens_at);
  const everyone = formatTime(m.early_access_until);
  const you = m.tier ? `Your tier (${m.tier}) can use it` : 'You can use it';
  return `${model} is in early access and is not open to you yet. ${opens ? `${you} from ${opens}.` : ''}${everyone && everyone !== opens ? ` It opens to everyone ${everyone}.` : ''} Nothing was charged. Choose another model, or see holder tiers for who gets in earlier.`.replace(/\s+/g, ' ');
}

// ---- advisory polls -------------------------------------------------------------------------------------------------

export const POLL_KINDS = { model_listing: 'Which model to list', slash_schedule: 'Slashing rules' };

/** A poll's options with their tallies and each option's share of the counted weight. */
export function pollRows(poll) {
  const tallies = Array.isArray(poll?.results?.options) ? poll.results.options : [];
  const total = num(poll?.results?.total_weight) || 0;
  return (Array.isArray(poll?.options) ? poll.options : []).map(option => {
    const t = tallies.find(x => x.option === option) || {};
    const weight = num(t.weight) || 0;
    return { option, votes: num(t.votes) || 0, weight, pct: total > 0 ? Math.round((weight / total) * 1000) / 10 : 0 };
  });
}

/** One line under a poll: what kind it is, when voting ends and whether the tally is final. */
export function pollSummary(poll, now = Date.now()) {
  const kind = POLL_KINDS[poll?.kind] || 'Poll';
  const r = poll?.results || {};
  const votes = `${num(r.total_votes) || 0} ${r.total_votes === 1 ? 'vote' : 'votes'}`;
  if (poll?.status === 'closed') return `${kind} · closed ${formatTime(poll.closed_at)} · ${votes} · final tally`;
  const closes = when(poll?.closes_at);
  const ends = closes == null ? 'no closing time set' : closes <= now ? 'voting has ended; the final tally is pending' : `voting ends ${formatTime(poll.closes_at)}`;
  return `${kind} · ${ends} · ${votes} so far`;
}

/** True while a vote can still be cast in this poll. */
export const pollOpen = (poll, now = Date.now()) => poll?.status === 'open' && !(when(poll.closes_at) != null && when(poll.closes_at) <= now);

/** The vote body. It names the poll as well as the option, so a signature cannot be used on another poll. */
export const voteBody = (pollId, option) => ({ poll_id: String(pollId), option: String(option) });
/** The canonical JSON of a vote body (keys sorted, no spaces): the bytes whose SHA-256 the wallet signs. */
export const voteCanonical = body => JSON.stringify({ option: body.option, poll_id: body.poll_id });

/**
 * The request for one vote: the body and the X-Wallet-Auth header. The wallet signs the method (POST), the router's
 * host, this poll's vote path, the time and the SHA-256 of the body's canonical JSON: a vote signed for one poll at one
 * router is not a vote anywhere else.
 * `signer` is { address, sign(bytes) -> base58 ed25519 signature } (lib/wallet.js walletSigner()); `host` is the
 * router's host (default: the one this page talks to).
 */
export async function voteRequest(signer, pollId, option, subtle = globalThis.crypto.subtle, now = Date.now(), host) {
  const body = voteBody(pollId, option);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(voteCanonical(body)));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { path: votePath(pollId), body, headers: { 'x-wallet-auth': await walletAuthHeader(signer, { method: 'POST', path: votePath(pollId), sha256: hex, host }, now) } };
}

/** A plain sentence for a refused vote. */
export function voteErrorMessage(error) {
  const byType = {
    not_a_holder: 'This wallet does not hold a tier with a vote, so its vote was not counted.',
    already_voted: 'This wallet has already voted in this poll. A vote cannot be changed.',
    poll_closed: 'Voting in this poll has ended.',
    balance_unavailable: 'The token balance could not be read just now. Try again shortly.',
    invalid_wallet_auth: 'The wallet signature was not accepted. Check your device clock and try again.',
    rate_limited: 'Too many votes from this wallet. Try again within a minute.',
  };
  return byType[error?.type] || error?.message || 'The vote could not be sent.';
}

/** The sentence shown after a vote is recorded. */
export const voteReceipt = vote => `Vote recorded for “${vote.option}” with the ${vote.tier} tier (weight ${vote.weight}). Polls are advisory: the result does not change anything by itself.`;

// ---- profile badge ----------------------------------------------------------------------------------------------------

/** The badge text for a public profile card (`trellis.holder_badge` is the tier's name), or null when none is shown. */
export function holderBadge(card) {
  const tier = card?.trellis?.holder_badge;
  return typeof tier === 'string' && tier.trim() ? `${tier.trim()} tier holder` : null;
}
