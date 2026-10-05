import { creditFailure, creditErrorText, insufficientCredits, upstreamMonitoring } from "../rush/monitor.ts"; import type { HealthTracker } from "../services/health.ts"; // ON3
import { captureNetworkReceipt } from "../network/receipt-link.ts";
import { openProviderHeaders } from "./headers.ts";
import { neverSent, providerFetch } from "./network.ts";
import type { Candidate } from "../catalog/catalog.ts";
import { decrypt } from "../lib/util.ts";
import { ACI_CONSTRAINTS, type AciExchange } from "./aci.ts";
import { ROUTER_FIELDS } from "../router/estimate.ts";
import { MAX_ANSWER_BYTES, MAX_ATTESTED_ANSWER_BYTES } from "../router/pricing.ts";

// OpenAI-compatible upstream calls. Every failure is classified so the router can decide
// whether to fall back (5xx, timeout, connection, 429, empty-200, provider-side 4xx) and what
// to record against the provider's health.

export type ErrorKind =
  | "http_5xx"
  | "timeout"
  | "connection"
  | "rate_limited"
  | "insufficient_credits" // ON3
  | "provider_auth"
  | "rejected"
  | "empty200"
  | "unreadable"
  | "oversize" // R5-01: a 200 whose body is larger than the router reads. The provider generated (and bills) it: billable, never retried elsewhere, never an outage
  | "interrupted"
  | "cancelled"; // the router stopped an in-flight call because its caller left (R4-02): never recorded against a provider

export type UpstreamFailure = { ok: false; status?: number; errorKind: ErrorKind; message: string; latencyMs: number };
/** `exchange` is set only for an attested aci/1 gateway: the bytes its receipt must commit to (providers/aci.ts). */
export type UpstreamJson = { ok: true; kind: "json"; status: number; json: any; latencyMs: number; exchange?: AciExchange };
export type UpstreamStream = { ok: true; kind: "stream"; status: number; events: AsyncGenerator<any>; first: any; latencyMs: number; abort: () => void; exchange?: AciExchange };
export type UpstreamResult = UpstreamJson | UpstreamStream | UpstreamFailure;

// Fields that only mean something to the router and must not reach providers: ROUTER_FIELDS (router/estimate.ts, which
// counts every OTHER field into the prompt bound, so what is forwarded and what is held are the same set).
// Parameters dropped quietly when a provider does not list them (OpenRouter behaviour);
// everything else is forwarded, and semantic parameters are filtered at selection time.
const DROPPABLE = new Set(["top_k", "min_p", "top_a", "repetition_penalty", "logit_bias", "seed", "logprobs", "top_logprobs", "stop", "presence_penalty", "frequency_penalty", "verbosity"]);

// Other names providers give an output limit. A caller cannot use one to ask a provider for more than the cap that was
// held: each is overwritten with the cap, and the "generate at least" variants are lowered to it.
const OUTPUT_LIMIT_ALIASES = ["max_new_tokens", "max_output_tokens", "max_gen_tokens", "num_predict", "max_length"];
const OUTPUT_FLOOR_ALIASES = ["min_tokens", "min_new_tokens", "min_completion_tokens", "min_length"];

/**
 * The body sent to a provider. With `cap` (every generating call passes one: router/execute.ts), the output limit that
 * was held is always sent explicitly (security review R3-02): `max_tokens`, and `max_completion_tokens` too when the
 * caller sent it or the offer lists it, both set to the cap whatever the caller asked for. A reasoning budget is
 * lowered to the cap as well. Calls with no output (embeddings) pass no cap and get no limit.
 */
export function upstreamBody(c: Candidate, body: Record<string, unknown>, stream: boolean, cap?: number) {
  const out: Record<string, unknown> = {};
  const supported = new Set(c.supportedParameters ?? []);
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (ROUTER_FIELDS.has(k) || v === undefined) continue;
    if (supported.size && DROPPABLE.has(k) && !supported.has(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  // OpenRouter's unified reasoning object -> OpenAI-style reasoning_effort when needed.
  const reasoning = body.reasoning as { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean } | undefined;
  if (reasoning && supported.size && !supported.has("reasoning")) {
    delete out.reasoning;
    if (supported.has("reasoning_effort") && reasoning.effort) out.reasoning_effort = reasoning.effort;
  }
  if (cap != null) {
    const limit = Math.max(1, Math.floor(cap));
    out.max_tokens = limit;
    if (body.max_completion_tokens != null || supported.has("max_completion_tokens")) out.max_completion_tokens = limit;
    for (const k of OUTPUT_LIMIT_ALIASES) if (out[k] != null) out[k] = limit;
    for (const k of OUTPUT_FLOOR_ALIASES) if (typeof out[k] === "number" && (out[k] as number) > limit) out[k] = limit;
    const r = out.reasoning as { max_tokens?: unknown } | undefined;
    if (r && typeof r === "object" && typeof r.max_tokens === "number" && r.max_tokens > limit) out.reasoning = { ...r, max_tokens: limit };
    const options = out.options as { num_predict?: unknown } | undefined; // Ollama-native servers read options.num_predict
    if (options && typeof options === "object" && !Array.isArray(options) && options.num_predict != null) out.options = { ...options, num_predict: limit };
  }
  out.model = c.providerModelId;
  // An attested gateway serves this request only from an upstream it verified in a TEE, under zero data retention.
  if (c.provider?.aci) out.provider = { ...ACI_CONSTRAINTS };
  if (stream) {
    out.stream = true;
    out.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
  } else delete out.stream;
  return { body: out, dropped };
}

export function providerKey(c: Candidate, secret: string, byokKey?: string) {
  if (byokKey) return byokKey;
  if (!c.provider.apiKeyEnc) return undefined;
  return decrypt(secret, c.provider.apiKeyEnc);
}

function classifyStatus(status: number): ErrorKind {
  if (status >= 500) return "http_5xx";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "provider_auth";
  return "rejected";
}

/** Provider error text is shown to callers: strip URLs, credentials and long hex, cap the length. */
export function sanitizeUpstream(msg: string) {
  // R4-06: cut first. The patterns below are linear on a bounded string; on a megabyte of provider (or echoed caller)
  // text the unanchored ones were quadratic. Nothing past the first 2,000 characters could survive the final cut anyway.
  return msg
    .slice(0, 2_000)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:sk|pk|rk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b0x[0-9a-fA-F]{32,}\b/g, "[hex]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[hex]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .slice(0, 200);
}

/** The most bytes of a non-streamed provider answer that are read, and of a stream in total (R4-26; the figure lives in router/pricing.ts with the bound it is compared with). */
export const MAX_RESPONSE_BYTES = MAX_ANSWER_BYTES;
/** R5-01: the size limit tripped. Distinct from an answer that is not JSON: this one the provider completed and bills. */
const oversize = () => Object.assign(new Error("Provider response exceeds the size limit."), { errorKind: "oversize" as ErrorKind });
async function boundedBytes(res: Response, max: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel().catch(() => {}); throw oversize(); }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw oversize();
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

/** At most this much of a provider's error body is read (R4-06, R4-26): the rest is discarded unread. */
const MAX_ERROR_BYTES = 64 * 1024;
async function boundedText(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, max - size));
      size += Math.min(value.byteLength, max - size);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}

async function errorMessage(res: Response, monitor = false) {
  try {
    const text = await boundedText(res, MAX_ERROR_BYTES);
    try {
      const j = JSON.parse(text);
      if (monitor && insufficientCredits(res.status, creditErrorText(j?.error ?? j))) return "Insufficient credits"; // ON3: classify explicit codes without retaining upstream text.
      return sanitizeUpstream(String(j?.error?.message ?? j?.message ?? text));
    } catch {
      return sanitizeUpstream(text);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;
export async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      // R4-26: a stream is bounded in total, and so is one event (a provider that never sends a blank line).
      total += value.byteLength;
      if (total > maxBytes || buffer.length > MAX_SSE_EVENT_CHARS) throw Object.assign(new Error("Provider stream exceeds the size limit."), { errorKind: "oversize" as ErrorKind });
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue; // comment / keep-alive
        if (data.trim() === "[DONE]") return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw Object.assign(new Error("Provider sent an unreadable stream event."), { errorKind: "unreadable" as ErrorKind });
        }
        yield parsed;
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data);
        } catch {
          /* trailing garbage */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function callUpstream(opts: {
  candidate: Candidate;
  health?: HealthTracker; // ON3
  path: "/chat/completions" | "/completions" | "/embeddings" | "/rerank";
  body: Record<string, unknown>;
  stream: boolean;
  apiKey?: string;
  appSecret?: string;
  signal: AbortSignal;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  production: boolean;
  /**
   * R4-26 / R5-01: the most bytes of a response body that are read (default MAX_RESPONSE_BYTES, never more). An answer
   * above it fails as `oversize`, which its caller must treat as billable.
   */
  maxResponseBytes?: number;
}): Promise<UpstreamResult> {
  const { candidate: c } = opts;
  const customHeaders = openProviderHeaders(opts.appSecret ?? "", c.provider.headers);
  const started = performance.now();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(opts.signal.reason);
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const totalTimer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), c.provider.timeoutMs ?? opts.timeoutMs);
  const cleanup = () => {
    clearTimeout(totalTimer);
    opts.signal.removeEventListener("abort", onAbort);
  };
  const elapsed = () => performance.now() - started;
  const maxBytes = Math.min(MAX_RESPONSE_BYTES, Math.max(1, opts.maxResponseBytes ?? MAX_RESPONSE_BYTES));
  const fail = (errorKind: ErrorKind, message: string, status?: number): UpstreamFailure => {
    cleanup();
    return { ok: false, errorKind, message, status, latencyMs: elapsed() };
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.stream ? "text/event-stream" : "application/json",
    ...customHeaders,
  };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  const requestBody = JSON.stringify(opts.body);
  const aci = !!c.provider?.aci;
  // Time-to-first-token applies to streams only: non-streaming providers send headers after generating.
  const firstTimer = opts.stream
    ? setTimeout(() => ctl.abort(new DOMException("first token timeout", "TimeoutError")), opts.firstTokenTimeoutMs)
    : undefined;
  try {
    res = await providerFetch(c.provider.baseUrl.replace(/\/$/, "") + opts.path, {
      method: "POST",
      redirect: "error",
      headers,
      body: requestBody,
      signal: ctl.signal,
    }, { production: opts.production, allowDevelopmentMockLoopback: !opts.production, tlsPin: c.provider.tlsPin, deadlineMs: (c.provider.timeoutMs ?? opts.timeoutMs) + 2_000 }); // R4-01: the transport's own timer backs the signal
  } catch (e) {
    clearTimeout(firstTimer);
    if (opts.signal.aborted) {
      cleanup();
      throw e;
    }
    // R5-01: a timeout is billable (the provider had the request and may bill it) only once the request was written. A
    // deadline that ran out while resolving, connecting or in the TLS handshake left the provider nothing to bill: that
    // is a connection failure, and the next provider is tried.
    const timeout = !neverSent.has(e as object) && ((e as Error)?.name === "TimeoutError" || (ctl.signal.reason as Error)?.name === "TimeoutError");
    return fail(timeout ? "timeout" : "connection", timeout ? "Provider timed out." : "Provider could not be reached.");
  }
  if (!res.ok) {
    clearTimeout(firstTimer);
    const message = await errorMessage(res, upstreamMonitoring(opts.health));
    if (await creditFailure(opts.health, c, opts.apiKey, res.status, message)) return fail("insufficient_credits", "Provider temporarily unavailable.", res.status); // ON3
    return fail(classifyStatus(res.status), message, res.status);
  }

  if (!opts.stream) {
    try {
      let json: any;
      let exchange: AciExchange | undefined;
      // R4-26: a body is read up to a cap, never without bound; past it the connection is dropped and the answer is unreadable.
      const bytes = await boundedBytes(res, maxBytes);
      json = JSON.parse(new TextDecoder().decode(bytes));
      // The gateway's receipt commits to the exact bytes: keep them.
      if (aci) exchange = { receiptId: res.headers.get("x-receipt-id"), requestBody, responseBody: () => bytes, drain: async () => {} };
      if (json?.error && await creditFailure(opts.health, c, opts.apiKey, res.status, creditErrorText(json.error))) return fail("insufficient_credits", "Provider temporarily unavailable.", res.status); // ON3
      clearTimeout(firstTimer);
      cleanup();
      return captureNetworkReceipt({ ok: true, kind: "json", status: res.status, json, latencyMs: elapsed(), ...(exchange ? { exchange } : {}) }, res, c);
    } catch (e) {
      clearTimeout(firstTimer);
      if (opts.signal.aborted) {
        cleanup();
        throw e;
      }
      const timeout = (ctl.signal.reason as Error)?.name === "TimeoutError";
      if (!timeout && (e as { errorKind?: ErrorKind }).errorKind === "oversize") return fail("oversize", "Provider returned an answer larger than the router reads.", res.status);
      return fail(timeout ? "timeout" : "unreadable", timeout ? "Provider timed out." : "Provider returned unreadable JSON.");
    }
  }

  if (!res.body) {
    clearTimeout(firstTimer);
    return fail("unreadable", "Provider returned an empty stream.");
  }
  const recorded = aci ? recordBody(res.body) : null;
  const events = parseSse(recorded ? recorded.stream : res.body, ctl.signal, maxBytes);
  // Wait for the first event so connection-level failures still allow fallback.
  let first: IteratorResult<any>;
  try {
    first = await events.next();
  } catch (e) {
    clearTimeout(firstTimer);
    if (opts.signal.aborted) {
      cleanup();
      throw e;
    }
    const kind: ErrorKind = (e as { errorKind?: ErrorKind }).errorKind ?? ((ctl.signal.reason as Error)?.name === "TimeoutError" ? "timeout" : "interrupted");
    return fail(kind, kind === "timeout" ? "Provider timed out before the first token." : "Provider stream failed.");
  }
  clearTimeout(firstTimer);
  if (first.done) return fail("empty200", "Provider stream ended without any event.");
  if (first.value?.error && await creditFailure(opts.health, c, opts.apiKey, res.status, creditErrorText(first.value.error))) { ctl.abort(); await events.return(undefined).catch(() => undefined); return fail("insufficient_credits", "Provider temporarily unavailable.", res.status); } // ON3
  const latencyMs = elapsed();
  const wrapped = (async function* () {
    try {
      for await (const ev of events) yield ev;
    } catch (e) {
      // R5-01: name the router's OWN cut (this call's total timer), whatever the transport rejected with, so the
      // reader of this stream can bill it as one. A cut by the caller's signal is the caller's to name.
      if (!opts.signal.aborted && (ctl.signal.reason as Error)?.name === "TimeoutError" && !(e as { errorKind?: ErrorKind }).errorKind) throw Object.assign(new Error("Provider timed out."), { name: "TimeoutError", errorKind: "timeout" as ErrorKind });
      throw e;
    } finally {
      cleanup();
    }
  })();
  const exchange: AciExchange | undefined = recorded ? { receiptId: res.headers.get("x-receipt-id"), requestBody, responseBody: recorded.bytes, drain: recorded.drain } : undefined;
  return captureNetworkReceipt({ ok: true, kind: "stream", status: res.status, events: wrapped, first: first.value, latencyMs, abort: () => ctl.abort(), ...(exchange ? { exchange } : {}) }, res, c);
}

/** The most response bytes kept for checking a gateway receipt; beyond it the response hash goes unchecked. */
const RECORD_LIMIT = MAX_ATTESTED_ANSWER_BYTES; // R5-09: an attested gateway's answers are read no further than this (router/pricing.ts answerLimitOf), so one that was read can always be checked

/**
 * Pass a response body through while keeping a copy of its bytes. `drain` reads whatever the consumer left
 * unread (the SSE parser stops at [DONE]), so `bytes` can cover the whole body; `bytes` is null while the body
 * is not finished or once it exceeded the limit.
 */
function recordBody(src: ReadableStream<Uint8Array>) {
  const reader = src.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        ctl.close();
        return;
      }
      size += r.value.byteLength;
      if (size > RECORD_LIMIT) overflow = true;
      else chunks.push(r.value);
      ctl.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const bytes = () => {
    if (!done || overflow) return null;
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) (out.set(c, at), (at += c.byteLength));
    return out;
  };
  const drain = async () => {
    if (done) return;
    const r = stream.getReader();
    const timer = setTimeout(() => r.cancel(new Error("drain timeout")).catch(() => undefined), 5_000);
    try {
      while (!(await r.read()).done);
    } finally {
      clearTimeout(timer);
      r.releaseLock();
    }
  };
  return { stream, bytes, drain };
}
