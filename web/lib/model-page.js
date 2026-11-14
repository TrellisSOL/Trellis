// The model page (/models/view/?id=author/slug): one model, the providers that serve it, and how each routing choice
// orders them. The ordering mirrors the router's (src/router/select.ts): the default spreads calls by
// uptime x quality x attested bonus / price^2; `:floor` sorts by blended price (3 parts prompt to 1 part completion);
// `:nitro` by p50 throughput; `:private` admits only endpoints served under the attested disclosure class.

export const ROUTES = [
  { key: 'balanced', suffix: '', label: 'Balanced', title: 'Balanced, the default.', text: 'Calls are spread across the providers that are up, weighted by uptime, quality and price, with a bonus for attested hardware. If one fails, the next answers.' },
  { key: 'floor', suffix: ':floor', label: 'Cheapest', title: 'Cheapest first.', text: 'Add :floor to the model. Providers are tried from the lowest blended price up; a failure falls through to the next one.' },
  { key: 'nitro', suffix: ':nitro', label: 'Fastest', title: 'Fastest first.', text: 'Add :nitro to the model. Providers are tried from the highest measured throughput down. A provider with no measurements yet goes last.' },
  { key: 'private', suffix: ':private', label: 'Proven hardware', title: 'Proven hardware only.', text: 'Add :private to the model. Only providers served under the attested class, with a fresh, verified attestation, can answer. If none is up, the call is refused rather than sent elsewhere.' },
];

const ATTESTED_BONUS = 1.25;
const perMillion = (perToken) => (perToken !== undefined && perToken !== null && Number.isFinite(Number(perToken)) ? Number((Number(perToken) * 1e6).toPrecision(12)) : null);

/** What a provider says it does with prompts, in a few words. */
export function dataLabel(policy = {}) {
  if (policy.retains_prompts) return 'Keeps prompts';
  if (policy.zdr) return 'Zero retention';
  if (policy.training === false) return 'No training on your data';
  return 'Data policy not declared';
}

/** One row per endpoint, with the numbers the page shows. */
export function providerRows(endpoints = []) {
  return endpoints.map((e) => {
    const input = perMillion(e.pricing?.prompt);
    const output = perMillion(e.pricing?.completion);
    return {
      slug: e.provider_slug,
      name: e.provider_name,
      initials: String(e.provider_name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
      input,
      output,
      blended: input === null || output === null ? null : (3 * input + output) / 4,
      latency: e.latency_last_30m?.p50 ?? null,
      throughput: e.throughput_last_30m?.p50 ?? null,
      uptime: typeof e.uptime_last_30d === 'number' ? e.uptime_last_30d : null,
      quality: typeof e.quality_score === 'number' ? e.quality_score : 1,
      down: e.status === -1,
      attested: !!e.attested,
      privateRoute: e.disclosure === 'attested' && !!e.attested,
      data: dataLabel(e.data_policy),
      context: e.context_length ?? null,
      quantization: e.quantization || null,
    };
  });
}

/**
 * How a routing choice treats each row: `rank` (1 = tried first) for the sorted routes, `share` (0..1) for the
 * default, and `excluded` with a reason when the row cannot answer under that choice.
 */
export function routeRows(rows, key) {
  const live = rows.filter((r) => !r.down && (key !== 'private' || r.privateRoute));
  const out = rows.map((r) => ({ ...r, rank: null, share: null, excluded: r.down ? 'Down right now' : key === 'private' && !r.privateRoute ? (r.attested ? 'Not on the attested class' : 'No attested hardware') : null }));
  if (key === 'balanced') {
    const weight = (r) => ((r.uptime ?? 100) / 100) * r.quality * (r.attested ? ATTESTED_BONUS : 1) / Math.max(r.blended ?? 1, 1e-9) ** 2;
    const total = live.reduce((a, r) => a + weight(r), 0);
    for (const r of out) if (!r.excluded && total > 0) r.share = weight(r) / total;
    return out;
  }
  const by = key === 'nitro'
    ? (a, b) => (b.throughput ?? -1) - (a.throughput ?? -1) || a.slug.localeCompare(b.slug)
    : (a, b) => (a.blended ?? Infinity) - (b.blended ?? Infinity) || a.slug.localeCompare(b.slug);
  [...live].sort(by).forEach((r, i) => { out.find((x) => x.slug === r.slug).rank = i + 1; });
  return out;
}

/** The summary strip: context, the cheapest prices, how many providers (and how many attested), the best uptime. */
export function modelSummary(model, rows) {
  const min = (k) => { const v = rows.map((r) => r[k]).filter((x) => x !== null); return v.length ? Math.min(...v) : null; };
  const uptimes = rows.map((r) => r.uptime).filter((x) => x !== null);
  return {
    context: model?.context_length ?? (rows.length ? Math.max(...rows.map((r) => r.context || 0)) : null),
    input: min('input'),
    output: min('output'),
    providers: rows.length,
    attested: rows.filter((r) => r.attested).length,
    uptime: uptimes.length ? Math.max(...uptimes) : null,
  };
}

/** Up to `n` other models of the same kind, the closest in price first. */
export function similarModels(all, model, n = 3) {
  if (!model) return [];
  const kind = (m) => (m.architecture?.output_modalities || ['text']).join(',');
  const price = (m) => Number(m.pricing?.prompt || 0) * 3 + Number(m.pricing?.completion || 0);
  const p = price(model);
  return all.filter((m) => m.id !== model.id && kind(m) === kind(model)).sort((a, b) => Math.abs(price(a) - p) - Math.abs(price(b) - p) || a.id.localeCompare(b.id)).slice(0, n);
}

/** `/models/view/?id=…` for a model id. */
export const modelHref = (id) => '/models/view/?id=' + encodeURIComponent(id);

/** Dollars per 1M tokens, short. */
export function usdPerM(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'Free';
  return '$' + (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
}
