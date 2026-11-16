// The Trust center (/trust/): live facts read from the router's public documents, the path of one request, the
// marks used across the site, and what a receipt does and does not prove. Pure helpers; components/TrustCenter.jsx
// fetches and renders.

const short = (s, n = 8) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-4)}` : s || '');
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * The four live cards, from GET /.well-known/trellis-receipt-keys.json, GET /api/v1/status,
 * GET /api/v1/status/slo and GET /api/v1/attestation/summary. A document that could not be read leaves its card
 * saying so, never a made-up value.
 */
export function liveCards({ keys = null, status = null, slo = null, summary = null, now = Date.now() } = {}) {
  const cards = [];
  const current = keys?.keys?.find((k) => !k.retired_at) || null;
  const rotation = status?.receipts?.rotation_days;
  cards.push(current
    ? { id: 'key', icon: 'key', state: 'ok', label: 'Receipt signing key', value: current.kid, note: `${current.alg || 'EdDSA'} key, signing since ${day(current.valid_from) ?? 'it was published'}.${rotation ? ` Rotated every ${rotation} days; ${keys.keys.length - 1} earlier ${keys.keys.length - 1 === 1 ? 'key stays' : 'keys stay'} listed so old receipts still check.` : ''}`, href: '/.well-known/trellis-receipt-keys.json', link: 'Open the key file' }
    : { id: 'key', icon: 'key', state: 'none', label: 'Receipt signing key', value: 'Unavailable', note: 'The key file could not be read just now.', href: '/.well-known/trellis-receipt-keys.json', link: 'Open the key file' });

  const anchor = keys?.anchor;
  const anchorer = anchor?.anchorer || anchor?.anchorers?.at?.(-1)?.key || null;
  const every = status?.receipts?.anchor_interval_ms;
  cards.push(anchorer
    ? { id: 'anchor', icon: 'anchor', state: 'ok', label: 'Anchoring on Solana', value: anchor.mode === 'memo' ? 'Hourly memo' : 'Hourly root', note: `Each hour's receipts become one Merkle root, posted by anchorer ${short(anchorer, 4)}${every ? `; checked every ${Math.round(every / 60000)} min` : ''}.`, href: '/verify/#v-receipt', link: 'Check a receipt’s anchor' }
    : { id: 'anchor', icon: 'anchor', state: 'warn', label: 'Anchoring on Solana', value: 'Not configured', note: 'This router has no anchorer key yet, so receipts are signed but not anchored. They say so themselves.', href: '/.well-known/trellis-receipt-keys.json', link: 'See the anchor settings' });

  const lane = slo?.lanes?.find((l) => l.lane === 'public');
  const w30 = lane?.windows?.['30d'];
  cards.push(w30 && typeof w30.availability === 'number'
    ? { id: 'uptime', icon: 'pulse', state: w30.availability >= (lane.target ?? 0) ? 'ok' : 'warn', label: 'Uptime, 30 days', value: `${(w30.availability * 100).toFixed(w30.availability === 1 ? 0 : 2)}%`, note: `${w30.eligible.toLocaleString('en-US')} calls counted, against a target of ${((lane.target ?? 0) * 100).toFixed(1)}%. Client errors are not counted against us.`, href: '/status/', link: 'Status and incidents' }
    : { id: 'uptime', icon: 'pulse', state: 'none', label: 'Uptime, 30 days', value: 'No data yet', note: 'Not enough calls in the window to state a figure.', href: '/status/', link: 'Status and incidents' });

  // "attested" is a fresh attestation the router verified; "simulated" is development evidence, never counted here.
  const providers = summary?.providers || [];
  const freshWithin = summary?.fresh_within_ms ?? 30 * 60_000;
  const attested = providers.filter((p) => p.status === 'attested' && p.attested_at && now - new Date(p.attested_at).getTime() <= freshWithin);
  const simulated = providers.filter((p) => p.status === 'simulated').length;
  const recheck = `re-checked every ${Math.round((summary?.attestation_interval_ms ?? 600000) / 60000)} minutes`;
  cards.push(summary
    ? { id: 'hardware', icon: 'chip', state: attested.length ? 'ok' : 'warn', label: 'Attested hardware', value: `${attested.length} of ${providers.length}`, note: providers.length ? `Providers whose enclave attestation the router verified in the last ${Math.round(freshWithin / 60000)} minutes, ${recheck}.${simulated ? ` ${simulated} more ${simulated === 1 ? 'shows' : 'show'} development evidence, which does not count.` : ''}` : 'No provider has registered attested hardware yet.', href: '/registry/', link: 'See each provider' }
    : { id: 'hardware', icon: 'chip', state: 'none', label: 'Attested hardware', value: 'Unavailable', note: 'The attestation summary could not be read just now.', href: '/registry/', link: 'See each provider' });
  return cards;
}

/** The path of one request, step by step: who sees the message and what each step keeps. */
export function requestPath(mode) {
  const priv = mode === 'private';
  return [
    { id: 'you', icon: 'user', title: 'You', sees: 'Your message and the answer.', keeps: priv ? 'History only if you turn it on, encrypted with your passphrase on this device.' : 'Nothing, unless you keep it.', changed: priv },
    { id: 'router', icon: 'router', title: 'Trellis router', sees: 'Your message, in memory, to route it.', keeps: 'No prompt or answer text. A receipt: model, provider, tokens, cost and hashes.', changed: false },
    { id: 'provider', icon: priv ? 'chip' : 'server', title: priv ? 'Attested provider' : 'Provider', sees: priv ? 'Your message, inside an enclave whose attestation the router checked within the last half hour.' : 'Your message, to run the model.', keeps: priv ? 'Only what the attested, measured software allows.' : 'What its data policy says. A promise, not a proof.', changed: priv },
    { id: 'receipt', icon: 'receipt', title: 'Receipt', sees: priv ? 'No text: hashes, model, provider, tokens, price and the attestation it ran under.' : 'No text: hashes, model, provider, tokens and price.', keeps: 'Signed with the router’s published key; public by its ID.', changed: priv },
    { id: 'chain', icon: 'blocks', title: 'Solana', sees: 'One root per hour: a hash over that hour’s receipts.', keeps: 'Permanently. Anyone can check a receipt against it.', changed: false },
  ];
}

export const PATH_NOTES = {
  standard: 'In Standard mode any live provider for the model can answer, and its data policy is shown on the model page.',
  private: 'Private mode sends calls only to providers serving under the attested class and labels every reply. The router still reads the message in memory to route it: Private keeps it from the provider’s operators, not from Trellis.',
};

/** The marks used on models, in Chat and on receipts. */
export const MARKS = [
  { id: 'verified', icon: 'check', label: 'Verified', means: 'The receipt’s signature checks against the router’s published key.' },
  { id: 'anchored', icon: 'anchor', label: 'Anchored', means: 'The receipt is in an hourly batch whose root is on Solana, and its inclusion proof checks.' },
  { id: 'hardware', icon: 'shield', label: 'Attested hardware', means: 'The provider’s enclave attestation was fresh and verified when it answered.' },
  { id: 'pending', icon: 'clock', label: 'Pending', means: 'Signed, and waiting for its hour to close and be anchored.' },
];

/** What came back from the checker, in the page's words: a headline, a tone and one line per check. */
export function checkView(result) {
  if (!result) return null;
  const sigUnchecked = result.checks.some((c) => (c.id === 'signature' || c.id === 'v2_signature') && c.status === 'not_checked');
  const tone = result.valid ? 'ok' : sigUnchecked ? 'warn' : 'bad';
  const head = result.valid ? 'Signature valid' : sigUnchecked ? 'Could not be checked here' : 'Does not verify';
  const anchor = result.anchor === 'proof_valid' ? 'Anchored: the inclusion proof checks against its root.' : result.anchor === 'proof_invalid' ? 'The inclusion proof in this receipt does not check.' : 'Pending: no inclusion proof yet. Receipts are rooted hourly.';
  return { tone, head, anchor, checks: result.checks.map((c) => ({ id: c.id, state: c.status, text: c.detail })), notChecked: result.notChecked || [] };
}

/** A receipt ID as the router issues them (gen-…), or null for anything else. */
export function receiptIdOf(text) {
  const t = String(text || '').trim();
  return /^[A-Za-z0-9_-]{6,128}$/.test(t) && !t.startsWith('{') ? t : null;
}
