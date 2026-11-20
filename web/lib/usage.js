// Usage breakdown (update 19): the dashboard's chart of a key's spend by model and by day, from GET /api/v1/usage.
// Pure (no React): the request path, the stacked bars and the money format. The router's answer is in src/api/usage.ts.

export const USAGE_UPDATE = 'usage';
export const USAGE_DAYS = 30;
export const USAGE_TOP = 6;
export const usagePath = (days = USAGE_DAYS, top = USAGE_TOP) => `/api/v1/usage?days=${days}&top=${top}`;

/** Series colours, in the site's greens and golds; "Other" is always the last, grey one. */
export const USAGE_COLORS = ['#2f6b43', '#d9ab3f', '#6f9e7a', '#a8662f', '#9bb8c9', '#7a5c8e'];
export const OTHER_COLOR = '#c9cbc2';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Dollars to the cent, and the first significant digits of a sum below a cent (so a cheap day never reads $0.00). */
export function formatUsd(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return '$' + n.toPrecision(2).replace(/0+$/, '');
  return usd.format(n);
}

/** "Nov 20" for a YYYY-MM-DD date, read as a UTC day (the router counts days in UTC). */
export const dayLabel = date => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The chart's series and bars from the router's answer. Each bar is one day: its total and a segment per series with a
 * height in percent of the busiest day. Series are the named models then, when there is one, "Other".
 */
export function usageChart(data) {
  if (!data || !Array.isArray(data.daily)) return { series: [], bars: [], peak: 0, empty: true };
  const series = (data.models || []).map((m, i) => ({ id: m.id, label: m.id, color: USAGE_COLORS[i % USAGE_COLORS.length], cost: m.cost_usd, requests: m.requests, share: m.share, daily: m.daily }));
  if (data.other) series.push({ id: '__other', label: `Other (${data.other.models} ${data.other.models === 1 ? 'model' : 'models'})`, color: OTHER_COLOR, cost: data.other.cost_usd, requests: data.other.requests, share: data.other.share, daily: data.other.daily });
  const peak = Math.max(0, ...data.daily.map(d => Number(d.cost_usd) || 0));
  const bars = data.daily.map((d, i) => ({
    date: d.date,
    total: Number(d.cost_usd) || 0,
    requests: d.requests,
    segments: series.map(s => ({ id: s.id, color: s.color, label: s.label, cost: Number(s.daily?.[i]) || 0, pct: peak > 0 ? ((Number(s.daily?.[i]) || 0) / peak) * 100 : 0 })).filter(seg => seg.cost > 0),
  }));
  return { series, bars, peak, empty: !(Number(data.totals?.requests) > 0) };
}

/** The bar's tooltip: the day, its total and each model's part. */
export const barTitle = bar => [`${dayLabel(bar.date)} · ${formatUsd(bar.total)} · ${bar.requests} ${bar.requests === 1 ? 'call' : 'calls'}`, ...bar.segments.map(s => `${s.label}: ${formatUsd(s.cost)}`)].join('\n');

export const sharePct = share => `${Math.round((Number(share) || 0) * 1000) / 10}%`;
