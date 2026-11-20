// The $TRLS burn tracker (update 18): what the router's burn job has burned, as GET /api/v1/trls/burns reports it.
// Pure helpers for app/burn/; no network access. Amounts arrive as decimal strings in whole tokens and are shown as
// they are (grouped, never rounded), so the page says exactly what the record says.

export const BURNS_PATH = '/api/v1/trls/burns';
export const BURN_UPDATE = 'burn-tracker';
export const BURN_OFF = 'The burn tracker is not enabled on this router.';
export const BURN_NOTE = 'Every burn is an ordinary token-program burn from the escrow wallet’s own token account, so anyone can check it on chain. The router writes a burn down once it is finalized.';

/** "1234567.5" → "1,234,567.5". Anything that is not a plain decimal is returned as "—". */
export function formatTokens(value) {
  const text = String(value ?? '');
  const m = /^(\d+)(\.\d+)?$/.exec(text);
  if (!m) return '—';
  return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[2] || '');
}

/** A transaction signature, shortened for a table cell. */
export const shortTx = tx => (typeof tx === 'string' && tx.length > 14 ? tx.slice(0, 6) + '…' + tx.slice(-6) : String(tx ?? ''));

/** Unix seconds as "11 Nov 2026, 12:00 UTC". */
export function formatWhen(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
  const d = new Date(at * 1000);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) + ', ' + d.toISOString().slice(11, 16) + ' UTC';
}

/** An explorer link from the router, or null when it is not an http(s) address. */
export const safeLink = url => (typeof url === 'string' && /^https?:\/\//.test(url) ? url : null);

/**
 * The cumulative series as an SVG line chart in a `width` x `height` box with `pad` around it: the line, the area under
 * it, a dot per day and the top of the scale. One day draws a flat line across. Nothing is drawn without points.
 */
export function chartGeometry(series, { width = 640, height = 220, pad = 24 } = {}) {
  const points = (Array.isArray(series) ? series : []).map(p => ({ day: p.day, amount: p.amount, cumulative: Number(p.cumulative) })).filter(p => typeof p.day === 'string' && Number.isFinite(p.cumulative));
  if (!points.length) return null;
  const max = Math.max(...points.map(p => p.cumulative)) || 1;
  const w = width - pad * 2, hgt = height - pad * 2;
  const x = i => pad + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = v => pad + hgt - (v / max) * hgt;
  const dots = points.map((p, i) => ({ ...p, x: Math.round(x(i) * 10) / 10, y: Math.round(y(p.cumulative) * 10) / 10 }));
  const line = points.length === 1
    ? `M${pad} ${dots[0].y} H${pad + w}`
    : dots.map((d, i) => `${i ? 'L' : 'M'}${d.x} ${d.y}`).join(' ');
  const first = points.length === 1 ? pad : dots[0].x, last = points.length === 1 ? pad + w : dots[dots.length - 1].x;
  const area = `${line} L${last} ${pad + hgt} L${first} ${pad + hgt} Z`;
  return { width, height, line, area, dots, max, baseline: pad + hgt, first: points[0].day, last: points[points.length - 1].day };
}
