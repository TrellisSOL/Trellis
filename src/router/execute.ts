import { hasUsage } from "./pricing.ts";
import { creditUnavailable } from "../rush/monitor.ts"; // ON3
import { rememberRouteResult } from "./explain.ts"; // V84
import { forwardNetworkReceipt } from "../network/receipt-link.ts";
import type { Candidate, ModelRow } from "../catalog/catalog.ts";
import { callUpstream, type ErrorKind, upstreamBody, type UpstreamFailure } from "../providers/upstream.ts";
import type { HealthTracker } from "../services/health.ts";
import type { AciExchange } from "../providers/aci.ts";

// Try providers in order, falling back on 5xx / timeout / connection / 429 / provider-auth /
// provider-side rejections / empty-200s. For streams, events are buffered until the first
// meaningful delta so that an empty or broken stream can still fall back invisibly.

export type Attempt = { provider: string; model: string; ok: boolean; error_kind?: ErrorKind; status?: number; latency_ms: number; message?: string };

export type RouteTarget = { model: ModelRow; ordered: Candidate[] };

/** `exchange` is set when the candidate is an attested aci/1 gateway (providers/aci.ts). */
export type RouteSuccess =
  | { ok: true; kind: "json"; candidate: Candidate; model: ModelRow; json: any; latencyMs: number; attempts: Attempt[]; dropped: string[]; exchange?: AciExchange; /** R4-02: an empty answer the provider metered: delivered and charged, kept as empty-200 evidence, never an outage. */ empty?: boolean }
  | {
      ok: true;
      kind: "stream";
      candidate: Candidate;
      model: ModelRow;
      buffered: any[];
      rest: AsyncGenerator<any>;
      latencyMs: number;
      attempts: Attempt[];
      abort: () => void;
      dropped: string[];
      exchange?: AciExchange;
      empty?: boolean;
    };
/**
 * A call that reached a provider and was cut off by the ROUTER (security review R4-02): at its own timeout ("timeout"),
 * or because the caller left and the drain window ran out ("cancelled"). The provider was working and may bill the
 * call, so routing stops there (no other provider is tried at the operator's cost) and the caller is charged what was
 * ordered from that provider (api/chat.ts). The same holds for an answer larger than the router reads ("oversize",
 * security review R5-01): the provider completed and metered it. A provider's own failure (5xx, a refused or reset connection,
 * a broken stream) is not billable: nothing is charged, nothing is owed, and the next provider is tried.
 */
export type Billable = { candidate: Candidate; model: ModelRow; kind: "timeout" | "cancelled" | "oversize"; latencyMs: number };
export type RouteFailure = { ok: false; attempts: Attempt[]; last?: UpstreamFailure; billable?: Billable };

/** Empty-200: content in {null, ""} with no tool calls, and finish_reason not length/content_filter. */
export function isEmptyCompletion(json: any, stopRequested = false): boolean {
  const choices = json?.choices;
  if (!Array.isArray(choices) || !choices.length) return true;
  return choices.every((ch: any) => {
    const msg = ch?.message ?? {};
    const text = ch?.text; // legacy completions
    const hasContent = (typeof msg.content === "string" && msg.content.length > 0) || (Array.isArray(msg.content) && msg.content.length > 0) || (typeof text === "string" && text.length > 0);
    const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasImages = Array.isArray(msg.images) && msg.images.length > 0;
    const finish = ch?.finish_reason;
    // An empty answer that ended on a caller-supplied stop sequence is a legitimate answer.
    if (stopRequested && finish === "stop") return false;
    return !hasContent && !hasTools && !hasImages && finish !== "length" && finish !== "content_filter";
  });
}

export function meaningfulDelta(ev: any): boolean {
  if (ev?.error) return false;
  for (const ch of ev?.choices ?? []) {
    const d = ch?.delta ?? {};
    if (typeof d.content === "string" && d.content.length) return true;
    if (typeof ch?.text === "string" && ch.text.length) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
    if ((typeof d.reasoning === "string" && d.reasoning.length) || (typeof d.reasoning_content === "string" && d.reasoning_content.length)) return true;
    if (Array.isArray(d.images) && d.images.length) return true;
    if (ch?.finish_reason === "length" || ch?.finish_reason === "content_filter") return true;
  }
  return false;
}

/** `events`, with `release` called once when the stream ends, fails or is closed by its reader. */
async function* releasing<T>(events: AsyncGenerator<T>, release: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    release();
  }
}

export async function route(opts: {
  targets: RouteTarget[];
  path: "/chat/completions" | "/completions";
  body: Record<string, unknown>;
  stream: boolean;
  appSecret?: string;
  keyFor: (c: Candidate) => string | undefined;
  signal: AbortSignal;
  health: HealthTracker;
  maxAttempts: number;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  production: boolean;
  caller?: string | null;
  /**
   * The output cap for a candidate: what was held for it, sent upstream as its explicit output limit (security review
   * R3-02; router/pricing.ts maxOutputTokens / capWithinBudget). Required, so no generating call can go out without
   * one. A candidate whose cap is below 1 is not attempted: the hold cannot cover even one token from it.
   */
  outputCap: (c: Candidate, model: ModelRow) => number;
  /**
   * SEALED-lane admission (src/holders/sealed-queue.ts): asked for a slot on the host before each attempt. Not admitted
   * (the host is full and the bounded wait ran out) is treated like a host that answered 429: the next candidate is
   * tried. Left out, every attempt goes straight to the host.
   */
  admit?: (providerId: string, signal: AbortSignal) => Promise<{ ok: true; release: () => void; waitedMs: number } | { ok: false; reason: string; waitedMs: number }>;
  /** R5-01: the most bytes of this candidate's answer that are read, given the output cap it is sent (default: the absolute cap). */
  responseCap?: (c: Candidate, cap: number) => number;
}): Promise<RouteSuccess | RouteFailure> {
  const stopRequested = opts.body.stop != null && !(Array.isArray(opts.body.stop) && opts.body.stop.length === 0);
  const attempts: Attempt[] = [];
  let last: UpstreamFailure | undefined;
  // Retry pass: providers that failed with a response proving they never accepted the request
  // (429 / 5xx) get one more try after a short backoff. Timeouts and interrupted streams are never
  // retried — the provider may have done (and billed) the work.
  const retryable = new Set<ErrorKind>(["rate_limited", "http_5xx", "connection"]);
  const passes: RouteTarget[][] = [opts.targets];
  for (let pass = 0; pass < passes.length; pass++) {
    if (pass === 1) await new Promise((r) => setTimeout(r, 250));
  for (const target of passes[pass]) {
    for (const c of target.ordered) {
      if (creditUnavailable(opts.health, c.providerId)) continue; // ON3: also skip precomputed fallback targets.
      if (attempts.length >= opts.maxAttempts) return { ok: false, attempts, last };
      const cap = opts.outputCap(c, target.model);
      if (!(cap >= 1)) {
        // Not a fault of the host: nothing is sent and nothing is recorded against its health.
        last = { ok: false, errorKind: "rejected", status: 400, message: "The amount held for this call cannot cover this provider's worst case.", latencyMs: 0 };
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: "rejected", status: 400, latency_ms: 0, message: last.message });
        continue;
      }
      const { body, dropped } = upstreamBody(c, opts.body, opts.stream, cap);
      const slot = opts.admit ? await opts.admit(c.providerId, opts.signal) : null;
      if (slot && !slot.ok) {
        if (opts.signal.aborted) throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
        // Not a fault of the host, so nothing is recorded against its health.
        last = { ok: false, errorKind: "rate_limited", status: 429, message: "The SEALED lane is at capacity on this host.", latencyMs: slot.waitedMs };
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: "rate_limited", status: 429, latency_ms: Math.round(slot.waitedMs), message: last.message });
        continue;
      }
      const release = slot?.ok ? slot.release : () => {};
      const attemptStarted = performance.now();
      /** The caller left and the drain ran out while this provider was working: stop, billable. */
      const cancelledHere = (): RouteFailure => {
        release();
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: "cancelled", latency_ms: Math.round(performance.now() - attemptStarted), message: "The caller left before the provider answered." });
        return { ok: false, attempts, last, billable: { candidate: c, model: target.model, kind: "cancelled", latencyMs: performance.now() - attemptStarted } };
      };
      let aborted = false;
      const r = await callUpstream({ health: opts.health, // ON3
        candidate: c,
        path: opts.path,
        body,
        stream: opts.stream,
        apiKey: opts.keyFor(c),
        appSecret: opts.appSecret,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        firstTokenTimeoutMs: opts.firstTokenTimeoutMs,
        production: opts.production,
        maxResponseBytes: opts.responseCap?.(c, cap),
      }).catch((e) => {
        if (opts.signal.aborted) { aborted = true; return null; }
        release();
        throw e;
      });
      if (aborted || !r) return cancelledHere();
      const failed = (f: UpstreamFailure) => {
        release();
        last = f;
        attempts.push({ provider: c.providerId, model: target.model.id, ok: false, error_kind: f.errorKind, status: f.status, latency_ms: Math.round(f.latencyMs), message: f.message });
        opts.health.record({ modelId: c.modelId, providerId: c.providerId, ok: false, errorKind: f.errorKind, statusCode: f.status ?? null, latencyMs: f.latencyMs, empty200: f.errorKind === "empty200", source: "traffic", caller: opts.caller ?? null });
      };
      if (!r.ok) {
        failed(r);
        // The router's own timeout cut off a provider that had the request: billable, and routing stops (R4-02). So
        // does an answer above the size the router reads (R5-01): the provider generated and metered all of it.
        if (r.errorKind === "timeout" || r.errorKind === "oversize") return { ok: false, attempts, last, billable: { candidate: c, model: target.model, kind: r.errorKind, latencyMs: r.latencyMs } };
        continue;
      }
      if (r.kind === "json") {
        if (r.json?.error && !r.json?.choices) {
          failed({ ok: false, errorKind: "http_5xx", status: r.status, message: String(r.json.error?.message ?? "provider error"), latencyMs: r.latencyMs });
          continue;
        }
        // An empty answer with no usage figures is a provider failure with no tokens: not charged, next provider.
        // One the provider completed AND metered is an answer (R4-02): it is delivered and charged its usage, not
        // retried elsewhere for free, and it does not count against the provider (the caller can ask for nothing).
        if (isEmptyCompletion(r.json, stopRequested) && !hasUsage(r.json?.usage)) {
          failed({ ok: false, errorKind: "empty200", status: 200, message: "Provider returned HTTP 200 with empty content.", latencyMs: r.latencyMs });
          continue;
        }
        attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(r.latencyMs) });
        release();
        return rememberRouteResult<RouteSuccess>(forwardNetworkReceipt({ ok: true, kind: "json", candidate: c, model: target.model, json: r.json, latencyMs: r.latencyMs, attempts, dropped, ...(r.exchange ? { exchange: r.exchange } : {}), ...(isEmptyCompletion(r.json, stopRequested) ? { empty: true } : {}) }, r), opts.targets);
      }
      // Stream: buffer until something meaningful arrives.
      const buffered: any[] = [r.first];
      let meaningful = meaningfulDelta(r.first);
      let streamError: UpstreamFailure | null = r.first?.error
        ? { ok: false, errorKind: "http_5xx", status: 200, message: String(r.first.error?.message ?? "stream error"), latencyMs: r.latencyMs }
        : null;
      const started = performance.now();
      while (!meaningful && !streamError) {
        let next: IteratorResult<any>;
        try {
          next = await r.events.next();
        } catch (e) {
          if (opts.signal.aborted) return cancelledHere();
          // The router's total timeout fired while it waited for content: its own cut, not the provider's failure.
          const timedOut = (e as Error)?.name === "TimeoutError";
          streamError = { ok: false, errorKind: (e as { errorKind?: ErrorKind }).errorKind ?? (timedOut ? "timeout" : "interrupted"), message: timedOut ? "Provider timed out before content." : "Provider stream failed before content.", latencyMs: r.latencyMs + (performance.now() - started) };
          break;
        }
        if (next.done) break;
        if (next.value?.error) {
          streamError = { ok: false, errorKind: "http_5xx", status: 200, message: String(next.value.error?.message ?? "stream error"), latencyMs: r.latencyMs };
          break;
        }
        buffered.push(next.value);
        meaningful = meaningfulDelta(next.value);
      }
      if (!meaningful && stopRequested && buffered.some((ev) => ev?.choices?.some((ch: any) => ch?.finish_reason === "stop"))) meaningful = true;
      // An empty stream the provider completed and metered is an answer, as for a non-streamed call (R4-02).
      let emptyMetered = false;
      if (!meaningful && !streamError && buffered.some((ev) => hasUsage(ev?.usage))) meaningful = emptyMetered = true;
      if (!meaningful) {
        r.abort();
        const f = streamError ?? { ok: false as const, errorKind: "empty200" as ErrorKind, status: 200, message: "Provider stream completed with empty content.", latencyMs: r.latencyMs + (performance.now() - started) };
        failed(f);
        if (f.errorKind === "timeout" || f.errorKind === "oversize") return { ok: false, attempts, last, billable: { candidate: c, model: target.model, kind: f.errorKind, latencyMs: f.latencyMs } };
        continue;
      }
      const ttft = r.latencyMs + (performance.now() - started);
      attempts.push({ provider: c.providerId, model: target.model.id, ok: true, status: r.status, latency_ms: Math.round(ttft) });
      // An admitted stream keeps its slot until it ends or is aborted.
      const rest = slot ? releasing(r.events, release) : r.events;
      const abort = slot ? () => { release(); r.abort(); } : r.abort;
      return rememberRouteResult<RouteSuccess>(forwardNetworkReceipt({ ok: true, kind: "stream", candidate: c, model: target.model, buffered, rest, latencyMs: ttft, attempts, abort, dropped, ...(r.exchange ? { exchange: r.exchange } : {}), ...(emptyMetered ? { empty: true } : {}) }, r), opts.targets);
    }
  }
    if (pass === 0 && attempts.length < opts.maxAttempts) {
      const again = opts.targets
        .map((t) => ({ model: t.model, ordered: t.ordered.filter((c) => attempts.some((a) => a.provider === c.providerId && a.model === t.model.id && a.error_kind && retryable.has(a.error_kind))) }))
        .filter((t) => t.ordered.length);
      if (again.length) passes.push(again);
    }
  }
  return { ok: false, attempts, last };
}
