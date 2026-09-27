// Enforced deadlines for calls that leave the process (security review round 4, R4-01).
//
// An AbortSignal alone is not a deadline: under the pinned runtime (Bun 1.3.14) node:http's `request({ signal })`
// closes the socket on abort and emits no `error`, so the caller's promise never settled, and nothing guarantees a
// library honours a signal at all. A deadline here is a RACE: the caller's promise settles when the timer fires,
// whatever the wrapped call does, and the wrapped call is told to stop (its signal is aborted and `onTimeout` runs) so
// the socket or reader it holds is released.

export class DeadlineError extends Error {
  override name = "TimeoutError";
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms.`);
  }
}

export const abortReason = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new DOMException(String(signal.reason ?? "The operation was aborted."), "AbortError"));

/**
 * Run `run` with a deadline. Rejects with a TimeoutError named after `what` when `ms` passes, and with the outer
 * signal's reason when that aborts first; either way the signal handed to `run` is aborted and `onTimeout` is called
 * once. A late result or error of the abandoned call is swallowed (it cannot become an unhandled rejection).
 */
export function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, o: { ms: number; what: string; onTimeout?: () => void; signal?: AbortSignal | null }): Promise<T> {
  const ctl = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void, stop: unknown | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (stop !== null) {
        ctl.abort(stop);
        try { o.onTimeout?.(); } catch { /* cleanup must not mask the timeout */ }
      }
      settle();
    };
    const onAbort = () => finish(() => reject(abortReason(o.signal!)), abortReason(o.signal!));
    const timer = setTimeout(() => {
      const err = new DeadlineError(o.what, o.ms);
      finish(() => reject(err), err);
    }, o.ms);
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    let p: Promise<T>;
    try {
      p = run(ctl.signal);
    } catch (e) {
      return finish(() => reject(e), null);
    }
    p.then((v) => finish(() => resolve(v), null), (e) => finish(() => reject(e), null));
  });
}

/**
 * `fetch` with an enforced deadline over the whole exchange, body included: the response body is read inside the
 * deadline and handed back as bytes, so no caller is left reading a stalled stream. For small JSON and text answers
 * (verifiers, key sets, balance checks, RPC); `maxBytes` bounds what is read.
 */
export async function deadlineFetch(input: string | URL, init: RequestInit & { fetchImpl?: typeof fetch } = {}, o: { ms: number; what: string; maxBytes?: number }): Promise<Response> {
  const { fetchImpl, signal, ...rest } = init;
  const max = o.maxBytes ?? 4 * 1024 * 1024;
  return withDeadline(async (inner) => {
    const res = await (fetchImpl ?? fetch)(input, { ...rest, signal: inner });
    if (Number(res.headers.get("content-length") ?? 0) > max) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${o.what}: the response exceeds ${max} bytes.`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (reader) {
      const stop = () => void reader.cancel().catch(() => {});
      inner.addEventListener("abort", stop, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) throw new Error(`${o.what}: the response exceeds ${max} bytes.`);
          chunks.push(value);
        }
      } finally {
        inner.removeEventListener("abort", stop);
        void reader.cancel().catch(() => {});
      }
      if (inner.aborted) throw abortReason(inner);
    }
    const noBody = res.status === 204 || res.status === 304 || res.status === 205;
    return new Response(noBody ? null : Buffer.concat(chunks, size), { status: res.status, statusText: res.statusText, headers: res.headers });
  }, { ms: o.ms, what: o.what, signal: signal ?? null });
}

/** A `fetch` whose every call has the enforced deadline above (a drop-in for code that takes a fetch implementation). */
export function guardedFetch(fetchImpl: typeof fetch, what: string, ms: number, maxBytes?: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => deadlineFetch(input as string | URL, { ...init, fetchImpl }, { ms, what, ...(maxBytes ? { maxBytes } : {}) })) as typeof fetch;
}
