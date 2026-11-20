// Price check (update 13): the page's side of POST /api/v1/estimate. Pure (no React), for components/estimate and its test.
// The router prices and bounds; nothing here computes a price. The prompt goes in the request body, never in a URL.

export const ESTIMATE_PATH = '/api/v1/estimate';
export const PRICE_CHECK_LIMITS = Object.freeze({ promptChars: 400_000, systemChars: 100_000, maxTokens: 1_000_000 });
export const OUTPUT_PRESETS = [256, 1024, 4096];

/** The request body, or the first problem with the form (a string). */
export function priceCheckBody({ prompt, system, maxTokens, pay }) {
  const text = String(prompt ?? '');
  if (!text.trim()) return 'Paste a prompt to price.';
  if (text.length > PRICE_CHECK_LIMITS.promptChars) return `A prompt can be at most ${PRICE_CHECK_LIMITS.promptChars.toLocaleString('en-US')} characters.`;
  const sys = String(system ?? '');
  if (sys.length > PRICE_CHECK_LIMITS.systemChars) return `A system prompt can be at most ${PRICE_CHECK_LIMITS.systemChars.toLocaleString('en-US')} characters.`;
  const n = maxTokens === '' || maxTokens === null || maxTokens === undefined ? NaN : Number(maxTokens);
  if (!Number.isSafeInteger(n) || n < 1 || n > PRICE_CHECK_LIMITS.maxTokens) return 'Set the most output tokens to a whole number from 1 to 1,000,000.';
  return { prompt: text, ...(sys.trim() ? { system: sys } : {}), max_tokens: n, pay: pay === 'per_call' ? 'per_call' : 'balance', limit: 200 };
}

/** A dollar string from the router, to six places below a cent and four above it (two from $100); a positive amount below a millionth shows as <. */
export function usdLabel(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n >= 0.01) return '$' + n.toFixed(n >= 100 ? 2 : 4);
  return n < 0.000001 ? '<$0.000001' : '$' + n.toFixed(6);
}

/** A per-token price string as dollars per million tokens. */
export function perMillion(value) {
  const n = Number(value);
  return value !== undefined && value !== null && Number.isFinite(n) ? '$' + (n * 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
}

export const FIT_TEXT = { context: 'Too long for its context window', output: 'Output cap above its limit' };

/** The answer as rows for the table, in the router's order (cheapest first). Throws on a body that is not the router's. */
export function priceRows(answer) {
  if (!answer || !Array.isArray(answer.data) || !Number.isInteger(answer.input_tokens)) throw new Error('The price check could not be read.');
  return answer.data.map(row => ({
    id: row.model,
    name: row.name || row.model,
    estimate: usdLabel(row.estimate_usd),
    hold: usdLabel(row.hold_usd),
    rates: `${perMillion(row.pricing?.prompt)} in · ${perMillion(row.pricing?.completion)} out per 1M`,
    output: row.output_tokens,
    fits: row.fits === true,
    problem: row.fits ? null : FIT_TEXT[row.problem] || 'Does not fit',
  }));
}
