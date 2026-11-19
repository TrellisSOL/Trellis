// The launch surface, as this site sees it.
//
// A router started with LAUNCH_SURFACE=core (the production default) serves only an allow-list of routes; every other
// API route answers 404 { error: { type: "not_enabled" } }. GET /api/v1/status reports it as
//   data.launch_surface = { surface: "core" | "all", core: [mounted route groups], off: [names of features that are off] }
// A router that does not report the field is an older one: the full surface ("all").
//
// The site keeps its OWN allow-list, below, and it is default-deny: when the router says `core`, a page, menu entry,
// account section, feature card or docs section that is not on a CORE list is treated as not enabled. The router's
// `off` names are shown to the reader and never used to decide. Something new is therefore off in core until it is
// added to a CORE list here (tests/launch-surface.test.mjs fails while a new entry is on neither list).
//
// Pure (no React). The status is read once per page load and shared; the last answer is kept in this tab's session
// storage as a hint, so the next page can hide non-core entries before its first paint (app/layout.jsx, globals.css).
import { ACCOUNT_SECTIONS } from './site-map.js';
import ROUTER_CORE from './core-routes.generated.json' with { type: 'json' };

export const NOT_ENABLED_TYPE = 'not_enabled';
export const NOT_ENABLED_TITLE = 'Not enabled on this router';
export const NOT_ENABLED_TEXT = 'This router runs the core launch surface, and this feature is not part of it.';
/** The notice as one string, for places that keep an error as text. */
export const NOT_ENABLED_MESSAGE = NOT_ENABLED_TITLE + '. ' + NOT_ENABLED_TEXT;
export const STATUS_PATH = '/api/v1/status';
export const HINT_KEY = 'trellis-launch-surface';
const API_BASE = (process.env.NEXT_PUBLIC_TRELLIS_API_URL || '').replace(/\/$/, '');

// ---- the allow-list -------------------------------------------------------------------------------------------------
// CORE: on in core. EXTRA: known, and off in core. Anything on neither list is also off in core.
//
// What core is: chat (chat completions, completions, embeddings), the model catalogue and provider list, API keys
// (create, list, revoke, limits), prepaid credits (deposit, deposit status, low-balance alert, account closure), wallet
// sign-in, x402 per call, receipts (lookup, proof, verify, the receipt key document, proof-pack checks in the browser),
// attestation records, status, the data inventory, holder tiers (the table, and a wallet's own tier where the router
// has released them: app/holders/Holders.jsx asks the router's release switches, not this list) and the docs.
//
// The router's side of this is its reviewed route table, security/launch-surface/core-routes.txt. This site holds a
// copy of it, lib/core-routes.generated.json (written by scripts/gen-core-routes.mjs; tests/launch-surface.test.mjs
// fails while the two differ), and the page and section lists below are DERIVED from it: an entry stays core only
// while every router route it needs (NEEDS) is in that table. A route that leaves the router's core surface takes the
// pages and sections that need it out of core here, without anyone editing these lists. A feature that is switched
// by a router setting and has no route of its own (route explanations, make-good refunds) cannot be derived that
// way: it is classified by hand, under EXTRA. An entry that is derived out is on neither list until someone moves it
// to EXTRA (the classification test fails meanwhile); it is already off in core, because core is default-deny.

/** The router's core routes as `METHOD /path`, from its snapshot file. */
export const ROUTER_CORE_ROUTES = ROUTER_CORE.map(line => line.slice(line.indexOf('\t') + 1));
/** The router routes a core page or account section cannot work without. An entry that is not named needs none. */
export const NEEDS = {
  page: {
    '/cost/': ['GET /api/v1/models'],
    '/dashboard/': ['GET /api/v1/key', 'GET /api/v1/keys', 'GET /api/v1/credits', 'GET /api/v1/generations'],
    '/harness/': ['POST /api/v1/chat/completions', 'GET /api/v1/models'],
    '/images/': ['GET /api/v1/media/models', 'POST /api/v1/images/generations', 'GET /api/v1/images/generations/:id'],
    '/video/': ['GET /api/v1/media/models', 'POST /api/v1/videos/generations', 'GET /api/v1/videos/generations/:id'],
    '/holders/': ['GET /api/v1/holders/tiers'],
    '/models/': ['GET /api/v1/models'],
    '/models/view/': ['GET /api/v1/models', 'GET /api/v1/models/:author/:slug/endpoints'],
    '/providers/': ['GET /api/v1/providers'],
    '/registry/': ['GET /api/v1/attestation/summary'],
    '/registry/[id]/': ['GET /api/v1/attestation/summary'],
    '/status/': ['GET /api/v1/status', 'GET /api/v1/status/slo'],
    '/tabs/': ['GET /api/v1/status'],
    '/trust/': ['GET /.well-known/trellis-receipt-keys.json', 'GET /api/v1/status', 'GET /api/v1/status/slo', 'GET /api/v1/attestation/summary', 'GET /api/v1/receipts/:id'],
    '/verify/': ['GET /api/v1/receipts/:id'],
  },
  section: {
    dashboard: ['GET /api/v1/key', 'GET /api/v1/credits'],
    playground: ['POST /api/v1/chat/completions'],
    models: ['GET /api/v1/models'],
    providers: ['GET /api/v1/providers'],
    'account-keys': ['GET /api/v1/keys', 'POST /api/v1/keys'],
    'account-payments': ['GET /api/v1/credits', 'POST /api/v1/credits/deposit-tx', 'GET /api/v1/credits/deposits'],
    'api-receipts': ['GET /api/v1/generations'],
  },
};
/** `ids` less the entries that need a route the table does not have (exact `METHOD /path`; default: the router's table). */
export const servedBy = (kind, ids, routes = ROUTER_CORE_ROUTES) => ids.filter(id => (NEEDS[kind]?.[id] || []).every(route => routes.includes(route)));

export const CORE = {
  // Pages, as app/**/page.jsx routes. /graft/ and /spec/ are reference reading: they stay open and carry one marker.
  page: servedBy('page', ['/', '/how-it-works/', '/cost/', '/dashboard/', '/docs/', '/whitepaper/', '/roadmap/', '/graft/', '/harness/', '/holders/', '/images/', '/video/', '/keep/', '/legal/privacy/', '/legal/terms/', '/models/', '/models/view/', '/providers/',
    '/registry/', '/registry/[id]/', '/spec/', '/spec/[doc]/', '/status/', '/tabs/', '/trust/', '/verify/']),
  // Menu, homepage-map, footer and search entries (lib/site-map.js TASKS).
  nav: ['chat', 'images', 'media-images', 'media-video', 'vision', 'voice', 'history', 'install', 'models', 'model-alternatives', 'prompt-library',
    'dashboard', 'api', 'cost', 'payments', 'lanes', 'registry', 'playground', 'settings', 'get-usdc', 'account-keys', 'account-payments', 'key-management',
    'unused-keys', 'deposit-countdown', 'tabs',
    'receipt', 'trust', 'status', 'keep', 'provider-check', 'proof-time', 'proof-pack-check',
    'docs', 'whitepaper', 'roadmap', 'about', 'privacy-notice', 'terms', 'holders'],
  // Account sections (lib/site-map.js ACCOUNT_SECTIONS, by task id): Home, Playground, Models, Providers, API keys, Payments, Receipts, Settings, What we keep.
  section: servedBy('section', ['dashboard', 'playground', 'models', 'providers', 'account-keys', 'account-payments', 'api-receipts', 'settings', 'keep']),
  // Search actions (lib/site-map.js ACTIONS).
  action: ['add-funds', 'new-key', 'open-receipt', 'chat-model'],
  // Homepage feature cards (components/FeatureGrid.jsx).
  card: ['intro', 'api', 'usdc', 'receipt', 'pay', 'fallback'],
  // Documentation sections (app/docs). Every section stays readable; the others get a "not enabled" marker.
  docs: ['quickstart', 'payments', 'get-usdc', 'deposit-countdown', 'balance-runway', 'routing', 'lanes', 'key-management', 'unused-keys', 'keep', 'errors', 'sdk',
    'holders', 'whats-new', 'tabs', 'facilitator'],
  // Named parts of core pages. None is core today: each names something a core page leaves out in core.
  part: [],
};

export const EXTRA = {
  // /tokens/ stays here although the router's table has the two blind routes: the page pays a one-time key through the
  // credits program (POST /api/v1/credits/deposit-tx with a program configured), which a router without it cannot take.
  page: ['/admin/', '/agents/', '/agents/directory/', '/agents/profile/', '/arena/', '/ask/', '/dashboard/webhooks/', '/hosts/', '/network/', '/tokens/', '/tools/'],
  nav: ['compare', 'files', 'encrypted', 'chat-limits',
    'account-activity', 'inbox', 'tokens', 'graft', 'unlinkable', 'proxy', 'spec', 'providers', 'routing', 'json-check', 'presets', 'characters', 'batches', 'teams', 'tracing',
    'evals', 'skills', 'spend', 'api-receipts', 'mcp', 'make-good', 'balance-runway', 'paid-tools', 'insights', 'webhooks', 'statements', 'account-export', 'operations',
    'agent-guard', 'rulebook', 'sessions', 'approvals', 'telegram', 'activity', 'alerts', 'breakers', 'autonomy', 'certificates', 'directory', 'profile', 'sealed', 'weekly-summary',
    'stop-until', 'starter-setups', 'replay-rules', 'pay-agent', 'request-check', 'playbooks', 'auto-topup', 'approve-and-allow', 'rulebook-words',
    'network', 'join', 'readiness', 'hosts', 'policy', 'interest',
    'key-log', 'inventory-log', 'badge', 'decision-tags', 'lane-report',
    // Route explanations are a setting the core surface refuses (ROUTE_EXPLAIN_ENABLED): no route of their own.
    'why-this-route'],
  section: ['insights', 'webhooks', 'inbox', 'account-activity', 'routing', 'presets', 'characters', 'evals', 'batches', 'skills', 'rulebook', 'playbooks', 'sessions', 'directory', 'spend',
    'teams', 'statements', 'account-export'],
  action: ['set-limit', 'stop-agent', 'resume-agent', 'default-route'],
  card: ['keys', 'profiles', 'sealed', 'telegram', 'shield', 'bond', 'otel', 'royalty', 'team'],
  docs: ['fast-credit', 'unlinkable-tor', 'private-tokens', 'key-log', 'anthropic', 'ollama', 'responses', 'batches', 'characters', 'rag', 'mcp', 'tracing', 'teams', 'run-a-provider', 'badge',
    'host-bonds', 'auto-topup', 'make-good-refunds', 'statements', 'lane-report', 'proof-pack', 'private', 'claude-unlinkable', 'e2ee-gateway', 'encrypted-chat',
    'structured-output', 'signed-webhooks', 'paid-tools', 'decision-tags', 'agent-rulebook', 'spending-limits', 'default-route', 'starter-setups', 'replay-rules', 'playbooks',
    'rulebook-words', 'agent-approvals', 'approve-and-allow', 'agent-guard', 'agent-pay', 'agent-breakers', 'agent-autonomy', 'stop-until', 'agent-ledger', 'agent-alerts', 'weekly-summary',
    'agent-certificates', 'agent-profiles', 'sealed-agents', 'open-network', 'network-host-signup', 'network-host-policy', 'network-payouts', 'network-stats', 'host-records',
    'why-this-route', // route explanations: a setting the core surface refuses, see nav
    // Sub-headings inside a core section that describe something core does not serve.
    'payments-blind-tokens', 'payments-pay-with', 'payments-byok', 'holder-votes', 'balance-runway-estimate'],
  // What a core page leaves out in core: a panel, a card, or a read of a route that is not served.
  part: ['agents', 'spend', 'activity', 'runway', 'inbox', 'pay-with', 'tracing', 'key-topup', 'telegram', 'saved-routes', 'chat-limits', 'holder-tier', 'holder-polls', 'badge',
    'inventory-log', 'run-provider'],
};

/** Docs sections of which only a part is off: the marker says which part. */
export const DOCS_NOTES = {
  'balance-runway-estimate': 'The runway estimate is not enabled on this router. The low-balance alert is.',
};

const name = surface => (surface && typeof surface === 'object' ? surface.surface : surface);
/** 'core', 'extra', or null when nobody classified it. */
export const classified = (kind, id) => (CORE[kind]?.includes(id) ? 'core' : EXTRA[kind]?.includes(id) ? 'extra' : null);
/** Whether to offer it. Everything is offered unless the router says `core`; in core only what is on a CORE list. */
export const enabled = (kind, id, surface) => name(surface) !== 'core' || !!CORE[kind]?.includes(id);
/** The attribute the stylesheet hides in core (`html[data-launch-surface="core"] [data-surface-extra]`), for JSX spread. */
export const extraAttr = (kind, id) => (CORE[kind]?.includes(id) ? {} : { 'data-surface-extra': '' });

/** A browser address as its page route: trailing slash, no index.html, dynamic segments as the app folder names them. */
export function pageRoute(pathname) {
  let p = String(pathname || '/').split(/[?#]/)[0].replace(/index\.html$/, '');
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p += '/';
  const dynamic = /^\/(registry|spec)\/[^/]+\/$/.exec(p);
  return dynamic ? `/${dynamic[1]}/[${dynamic[1] === 'registry' ? 'id' : 'doc'}]/` : p;
}
export const pageEnabled = (pathname, surface) => enabled('page', pageRoute(pathname), surface);

/** What a same-site link opens: a docs section, an account section or a page. null for anything else (mail, other sites). */
export function hrefTarget(href) {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return null;
  const [pathname, hash = ''] = href.split('#');
  const route = pageRoute(pathname);
  if (hash && route === '/docs/' && classified('docs', hash)) return { kind: 'docs', id: hash };
  if (hash && route === '/dashboard/') {
    const section = ACCOUNT_SECTIONS.find(item => item.hash === hash);
    if (section) return { kind: 'section', id: section.taskId };
  }
  return { kind: 'page', id: route };
}
export function hrefEnabled(href, surface) {
  const target = hrefTarget(href);
  return !target || enabled(target.kind, target.id, surface);
}

// ---- the router's answer ----------------------------------------------------------------------------------------------

const names = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string' && item) : []);
/** `data` of GET /api/v1/status as { surface, core, off }. Absent field: 'all'. Present with anything but "all": 'core'. */
export function surfaceOf(status) {
  const field = status?.launch_surface;
  if (!field || typeof field !== 'object') return { surface: 'all', core: [], off: [] };
  return { surface: field.surface === 'all' ? 'all' : 'core', core: names(field.core), off: names(field.off) };
}
/** A raw answer: HTTP 404 whose JSON body is { error: { type: "not_enabled" } }. */
export const notEnabledAnswer = (status, body) => Number(status) === 404 && body?.error?.type === NOT_ENABLED_TYPE;
/** An ApiError (lib/api.js) made from that answer. */
export const isNotEnabled = error => Number(error?.status) === 404 && error?.type === NOT_ENABLED_TYPE;
/** Error text that is the notice (optionally followed by the router's own sentence). */
export const isNotEnabledText = text => typeof text === 'string' && text.startsWith(NOT_ENABLED_MESSAGE);

// ---- one shared reading per page load ---------------------------------------------------------------------------------

const UNKNOWN = Object.freeze({ surface: 'unknown', ready: false, core: [], off: [] });
const listeners = new Set(), refusals = new Set();
let pending = null;
let released = [];

function readHint() {
  try {
    const value = globalThis.sessionStorage?.getItem(HINT_KEY);
    return value === 'core' || value === 'all' ? { surface: value, ready: false, core: [], off: [] } : UNKNOWN;
  } catch { return UNKNOWN; }
}
// In a browser the first render after hydration already has the last answer of this tab. A hint never mounts a non-core
// page (gateView): only the router's fresh answer does.
let state = typeof window === 'undefined' ? UNKNOWN : readHint();

function apply(next) {
  state = next;
  if (next.ready && !next.unreachable) {
    try { globalThis.sessionStorage?.setItem(HINT_KEY, next.surface); } catch { /* the hint is optional */ }
  }
  try { const root = globalThis.document?.documentElement; if (root?.dataset && next.surface !== 'unknown') root.dataset.launchSurface = next.surface; } catch { /* no document */ }
  for (const listener of [...listeners]) listener(state);
  return state;
}

export const getLaunchSurface = () => state;
/** What a server render (and the browser's hydration pass, which must match it) sees: nothing known yet. */
export const serverLaunchSurface = () => (typeof window === 'undefined' ? state : UNKNOWN);
export function subscribeLaunchSurface(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Record an answer that is already known ({ surface, core, off }, e.g. from a status read the page made itself). */
export function setLaunchSurface(value) {
  const next = apply({ surface: value?.surface === 'core' ? 'core' : 'all', ready: true, core: names(value?.core), off: names(value?.off) });
  pending = Promise.resolve(next);
  return next;
}
/** Forget everything (tests). `hint: true` starts from this tab's remembered answer, as a fresh page load does. */
export function resetLaunchSurface({ hint = false } = {}) { pending = null; released = []; state = hint ? readHint() : UNKNOWN; }
/** The prepared updates the router has switched on (its status `updates`), by name: empty until its status was read. */
export const releasedUpdates = () => released;

/**
 * Read GET /api/v1/status once and share the answer. A router that cannot be reached says nothing about its surface:
 * that reads as the full surface for now (every call fails on its own anyway), unless this tab last saw `core`, and
 * the next caller asks again.
 */
export function loadLaunchSurface({ fetcher, base = API_BASE } = {}) {
  if (pending) return pending;
  const mine = (async () => {
    try {
      const response = await (fetcher || globalThis.fetch)(base + STATUS_PATH, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json())?.data;
      released = Array.isArray(data?.updates) ? data.updates.filter(u => u?.on === true && typeof u.name === 'string').map(u => u.name) : [];
      const next = apply({ ...surfaceOf(data), ready: true });
      return next;
    } catch {
      if (pending === mine) pending = null;
      // A not_enabled answer that arrived meanwhile is the router speaking: keep it. So is a remembered `core`: with no
      // fresh answer, nothing non-core is mounted on the strength of a failed read.
      if (state.ready && state.surface === 'core') return state;
      return apply({ surface: state.surface === 'core' ? 'core' : 'all', ready: true, core: [], off: [], unreachable: true });
    }
  })();
  pending = mine;
  return mine;
}
/** For code outside React: whether to make a call (or show a part) once the router has answered. */
export async function surfaceAllows(kind, id) { return enabled(kind, id, (await loadLaunchSurface()).surface); }

/** Called with the request path whenever the API answers 404 not_enabled. */
export function onNotEnabled(listener) { refusals.add(listener); return () => { refusals.delete(listener); }; }
/** The router refused a route as not enabled: it runs core, whatever was assumed before. */
export function reportNotEnabled(pathname) {
  if (state.surface !== 'core') { const next = apply({ surface: 'core', ready: true, core: state.core, off: state.off }); pending = Promise.resolve(next); }
  for (const listener of [...refusals]) listener(pathname);
}

/**
 * For code that calls fetch itself: true when `response` is a 404 not_enabled answer, after telling the page. It reads
 * a copy, so the caller can still read the body.
 */
export async function refused(response, pathname) {
  if (response?.status !== 404) return false;
  let body = null;
  try { body = await response.clone().json(); } catch { /* not JSON */ }
  if (!notEnabledAnswer(404, body)) return false;
  reportNotEnabled(String(pathname || '').split('?')[0]);
  return true;
}

/**
 * What a gate shows. `allowed` is the allow-list's answer for the page or part. A non-core part is held back until the
 * router has answered (so it makes no call to a route that is not served), shown on the full surface, and replaced by
 * the notice in core. A remembered `core` shows the notice at once; a remembered `all` still waits.
 */
export function gateView(allowed, surface = state) {
  if (allowed) return 'show';
  if (surface.surface === 'core') return 'notice';
  return surface.ready ? 'show' : 'hold';
}
