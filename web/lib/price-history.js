// Price history (update 22): the chart on a model page, from GET /api/v1/models/:author/:slug/prices.
//
// The router records a row only when a model's lowest input or output price changes, so a price holds from one row to
// the next: the chart is a step line. It starts at the price in force when the window opened (`before`), or at the
// first recorded change when nothing was recorded earlier, and runs to now at the latest price. Nothing is drawn where
// nothing was recorded. Pure (no React), so tests/price-history.test.mjs can check it.

export const RANGES = Object.freeze([{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: '1 year' }]);
export const pricesPath = (id, days) => `/api/v1/models/${String(id).split('/').map(encodeURIComponent).join('/')}/prices?days=${days}`;

/** The two step series, as [time in ms, USD per million tokens] corners, over [from, to]. */
export function stepSeries(data, now = Date.now()) {
  const since = Date.parse(data?.since);
  const points = [...(data?.before ? [{ ...data.before, at: data.since }] : []), ...(data?.points || [])]
    .map((p) => ({ t: Math.max(Date.parse(p.at), since), input: p.input_usd_per_m, output: p.output_usd_per_m }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.input) && Number.isFinite(p.output));
  if (!points.length) return null;
  const to = Math.max(now, points[points.length - 1].t);
  const series = (key) => {
    const out = [];
    for (const p of points) {
      if (out.length) out.push([p.t, out[out.length - 1][1]]);
      out.push([p.t, p[key]]);
    }
    out.push([to, out[out.length - 1][1]]);
    return out;
  };
  const input = series('input'), output = series('output');
  const max = Math.max(...input.map((c) => c[1]), ...output.map((c) => c[1]));
  return { from: points[0].t, to, input, output, max, changes: (data.points || []).length };
}

/** A nice upper bound for the y axis and its ticks. */
export function yTicks(max, count = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Number((step * Math.ceil(max / step)).toPrecision(12));
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { top, ticks };
}

/** An SVG path for a series inside a box of width w and height h. */
export function seriesPath(corners, from, to, top, w, h) {
  const span = Math.max(1, to - from);
  const x = (t) => ((t - from) / span) * w;
  const y = (v) => h - (top > 0 ? (v / top) * h : 0);
  return corners.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
}

export const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
