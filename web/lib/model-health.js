// Model health (update 17): how each model has been doing over the last 24 hours, as the router's
// GET /api/v1/models/health reports it. Pure helpers for the model page and the models list; no network access.
// The router computes the figures from its own attempt records and leaves a figure null when there are too few.

export const HEALTH_PATH = '/api/v1/models/health';
export const HEALTH_UPDATE = 'model-health';
export const HEALTH_NOTE = 'Measured by this router on real traffic over the last 24 hours: each attempt it sent to a provider, with the caller’s own refusals, cancellations and provider rate limits left out. The time is to the first response (the first token for a stream).';

/** The router's list as a Map by model id; anything malformed is skipped. */
export function healthById(list) {
  const map = new Map();
  for (const entry of Array.isArray(list) ? list : []) if (entry && typeof entry.model === 'string') map.set(entry.model, entry);
  return map;
}

/** 0.9876 → "98.8%"; 1 → "100%"; null → "—". */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  const pct = Math.min(100, Math.max(0, rate * 100));
  return (pct === 100 || pct === 0 ? String(pct) : pct.toFixed(1)) + '%';
}

/** 820 → "820 ms"; 1830 → "1.8 s"; null → "—". */
export function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + ' s';
}

/** good (99% or more), fair (95% or more), poor, or none without a figure. */
export function healthTone(entry) {
  const rate = entry?.success_rate;
  if (typeof rate !== 'number') return 'none';
  return rate >= 0.99 ? 'good' : rate >= 0.95 ? 'fair' : 'poor';
}

/** One line for a model card. */
export function healthLine(entry) {
  if (!entry || !entry.attempts) return 'No calls in the last 24 hours';
  if (typeof entry.success_rate !== 'number') return 'Too few calls in the last 24 hours to say';
  const median = entry.latency_ms ? ' · median ' + formatMs(entry.latency_ms.p50) : '';
  return formatRate(entry.success_rate) + ' succeeded' + median;
}

/** The figures of the model page strip: [label, value, unit]. */
export function healthFigures(entry) {
  return [
    ['Succeeded', formatRate(entry?.success_rate), ''],
    ['Median response', formatMs(entry?.latency_ms?.p50), ''],
    ['p95 response', formatMs(entry?.latency_ms?.p95), ''],
    ['Attempts', String(entry?.attempts ?? 0), entry?.failed ? `· ${entry.failed} failed` : ''],
  ];
}
