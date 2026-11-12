// The Funds page (dashboard Payments): balance history, what an amount buys at the account's own recent prices, and one
// activity list of deposits and daily spending. Pure helpers; components/funds/FundsCenter.jsx renders them.

export const PRESETS = [5, 10, 25, 50, 100];
const DAY = 86_400_000;

const timeOf = (x) => {
  const t = Date.parse(x?.time ?? x?.credited_at ?? x?.submitted_at ?? x?.created_at ?? '');
  return Number.isNaN(t) ? null : t;
};
const credited = (d) => Number(d.credited_usd ?? d.worth_usd ?? d.amount ?? 0) || 0;
const counted = (d) => ['credited', 'final', 'provisional'].includes(d.stage);

/**
 * The balance at the end of each of the last `days` days, walked back from today's balance through the receipts
 * (spending) and credited deposits that fall in the window. Oldest first; the last point is the current balance.
 */
export function balanceSeries({ balance = 0, receipts = [], deposits = [], days = 14, now = Date.now() } = {}) {
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const edges = Array.from({ length: days }, (_, i) => end.getTime() - (days - 1 - i) * DAY);
  const events = [
    ...receipts.map((r) => ({ t: timeOf(r), delta: -(Number(r.cost) || 0) })),
    ...deposits.filter(counted).map((d) => ({ t: timeOf(d), delta: credited(d) })),
  ].filter((e) => e.t !== null);
  let v = Number(balance) || 0;
  const out = new Array(days);
  for (let i = days - 1; i >= 0; i--) {
    out[i] = { t: edges[i], v: Math.max(0, v) };
    const from = edges[i] - DAY;
    for (const e of events) if (e.t > from && e.t <= edges[i]) v -= e.delta; // undo that day's events
  }
  return out;
}

/** Spending over the last 30 days and the average cost of one answer (from the most recent 50 that cost anything). */
export function spendStats(receipts = [], now = Date.now()) {
  const recent = receipts.filter((r) => { const t = timeOf(r); return t !== null && now - t <= 30 * DAY; });
  const paid = receipts.filter((r) => Number(r.cost) > 0).slice(0, 50);
  return {
    spent30d: recent.reduce((a, r) => a + (Number(r.cost) || 0), 0),
    calls30d: recent.length,
    avgCost: paid.length ? paid.reduce((a, r) => a + Number(r.cost), 0) / paid.length : null,
  };
}

/** About how many answers an amount pays for at an average cost, or null without one. */
export function answersFor(amount, avgCost) {
  const a = Number(amount);
  if (!avgCost || !Number.isFinite(a) || a <= 0) return null;
  return Math.floor(a / avgCost);
}

/** Round a large count for a sentence: 1,234 -> "1,200", 98,765 -> "99,000". */
export function roughly(n) {
  if (n === null || n === undefined) return null;
  if (n < 1000) return n.toLocaleString('en-US');
  const p = 10 ** (String(Math.floor(n)).length - 2);
  return (Math.round(n / p) * p).toLocaleString('en-US');
}

/** One list, newest first: each deposit, and spending grouped by day (with its call count). */
export function activityItems({ receipts = [], deposits = [], limit = 12 } = {}) {
  const days = new Map();
  for (const r of receipts) {
    const t = timeOf(r);
    if (t === null) continue;
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    const row = days.get(k) || { kind: 'spend', id: 'spend-' + k, t: k, amount: 0, count: 0 };
    row.amount += Number(r.cost) || 0;
    row.count += 1;
    days.set(k, row);
  }
  const deps = deposits.map((d) => ({ kind: 'deposit', id: 'dep-' + d.id, t: timeOf(d) ?? 0, amount: credited(d), symbol: d.symbol || 'USDC', stage: d.stage, url: d.tx_url || null, final: counted(d) }));
  return [...deps, ...days.values()].sort((a, b) => b.t - a.t).slice(0, limit);
}

/** Dollars, with more places for small amounts so a fraction of a cent still shows. */
export function usd(n, { small = false } = {}) {
  const v = Number(n) || 0;
  const places = small && v > 0 && v < 0.01 ? 6 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

/** The SVG path of a series in a w×h box (line and the area under it). */
export function sparkPaths(series, w = 320, h = 72, pad = 4) {
  if (!series.length) return { line: '', area: '' };
  const vs = series.map((p) => p.v);
  // A balance chart starts at $0, so a fraction of a cent spent never looks like a cliff.
  const max = Math.max(...vs), min = Math.min(0, ...vs);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, series.length - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = series.map((p, i) => [x(i), max === min ? h / 2 : y(p.v)]);
  const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)} ${b.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${pts.at(-1)[0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`, last: pts.at(-1) };
}
