import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect as netConnect, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from "node:tls";
import { DeadlineError, abortReason } from "../lib/deadline.ts";
import { spkiSha256Of, type TlsPin } from "./tls-pin.ts";

/** Bound untrusted discovery/attestation JSON, including chunked responses. */
export async function boundedJson(response: Response, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Provider response exceeds the size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Provider response exceeds the size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Address = { address: string; family: number };
type NetworkPolicy = {
  production: boolean;
  allowDevelopmentMockLoopback?: boolean;
  allowDevelopmentLoopbackHostnames?: string[];
  resolve?: (hostname: string) => Promise<Address[]>;
  /** An attested provider's pinned certificate (providers/tls-pin.ts): the only certificate its connections accept. */
  tlsPin?: Pick<TlsPin, "certPem" | "spkiSha256" | "spkiOnly"> | null;
  /**
   * Milliseconds from the call to the response headers (DNS, connect, TLS, request, wait). Enforced by a timer in this
   * module, with or without a caller's signal (security review R4-01). Default DEFAULT_DEADLINE_MS.
   */
  deadlineMs?: number;
  /** Milliseconds for the whole exchange, body included. Default: no limit beyond `deadlineMs` and the caller's signal. */
  totalMs?: number;
};

export const DEFAULT_DEADLINE_MS = 120_000;
const MAX_HEADER_BYTES = 64 * 1024;
/** Interim (1xx) responses one exchange may carry before its final response (security review R5-13). */
const MAX_INTERIM_RESPONSES = 16;
/** Response bytes held for a reader that has not asked for them yet; above it the socket is paused. */
const QUEUE_HIGH_WATER = 1024 * 1024;

// Development and tests only: extra trust roots for https providers on loopback (a production policy never reads them).
let developmentCa: string[] = [];
export function setDevelopmentCa(pems: string[]) {
  developmentCa = pems;
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function v4In(address: number, base: number, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function isPublicIpv4(address: string) {
  const n = ipv4Number(address);
  if (n === null) return false;
  const blocked: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => v4In(n, ipv4Number(base)!, prefix));
}

function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let value = address.toLowerCase();
  if (value.includes(".")) {
    const i = value.lastIndexOf(":");
    const v4 = ipv4Number(value.slice(i + 1));
    if (i < 0 || v4 === null) return null;
    value = `${value.slice(0, i)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").map((x) => Number.parseInt(x, 16)) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").map((x) => Number.parseInt(x, 16)) : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (zeros < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(zeros).fill(0), ...right];
  return words.length === 8 && words.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? words : null;
}

function ipv6Prefix(words: number[], prefix: number, expected: number[]) {
  const fullWords = Math.floor(prefix / 16);
  for (let i = 0; i < fullWords; i++) if (words[i] !== expected[i]) return false;
  const tail = prefix % 16;
  if (tail) {
    const mask = (0xffff << (16 - tail)) & 0xffff;
    return (words[fullWords] & mask) === (expected[fullWords] & mask);
  }
  return true;
}

function isPublicIpv6(address: string) {
  const words = ipv6Words(address);
  if (!words) return false;
  // Only global-unicast space is eligible. Reject special-use, documentation, and transition
  // ranges even though some of them sit inside 2000::/3.
  if (!ipv6Prefix(words, 3, [0x2000])) return false;
  return ![
    [32, [0x2001, 0x0db8]], // documentation
    [23, [0x2001]], // IETF special-purpose assignments
    [16, [0x2002]], // 6to4 embeds arbitrary IPv4 destinations
    [20, [0x3fff]], // documentation
  ].some(([prefix, base]) => ipv6Prefix(words, prefix as number, base as number[]));
}

export function isPublicAddress(address: string) {
  return isIP(address) === 4 ? isPublicIpv4(address) : isIP(address) === 6 ? isPublicIpv6(address) : false;
}

function resolveWithSignal(resolve: Promise<Address[]>, signal?: AbortSignal | null): Promise<Address[]> {
  if (!signal) return resolve;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  return new Promise((accept, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    resolve.then((value) => { cleanup(); accept(value); }, (error) => { cleanup(); reject(error); });
  });
}

function isLoopbackAddress(address: string) {
  return ipv4Number(address) !== null ? v4In(ipv4Number(address)!, ipv4Number("127.0.0.0")!, 8) : address.toLowerCase() === "::1";
}

function hostnameFrom(url: URL) {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
}

/** Check a provider URL and resolve it to one reviewed address (public, or loopback for development mocks). */
async function resolveDestination(url: URL, policy: NetworkPolicy, signal?: AbortSignal | null) {
  const host = hostnameFrom(url);
  if (!(url.protocol === "https:" || (!policy.production && url.protocol === "http:")) || url.username || url.password || url.hash)
    throw new Error("Provider URL must use HTTPS in production and cannot contain credentials or a fragment.");
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  const literalFamily = isIP(host);
  const resolved = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await resolveWithSignal((policy.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(host), signal);
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  if (!resolved.length) throw new Error("Provider hostname did not resolve.");
  const devLoopback = !policy.production && policy.allowDevelopmentMockLoopback === true &&
    (host === "localhost" || host === "localhost.localdomain" || policy.allowDevelopmentLoopbackHostnames?.includes(host) || (literalFamily > 0 && isLoopbackAddress(host)));
  if (devLoopback ? !resolved.every((x) => isLoopbackAddress(x.address)) : !resolved.every((x) => isPublicAddress(x.address)))
    throw new Error("Provider destination resolves to a non-public address.");
  return { host, literalFamily, pinned: resolved[0] };
}

/**
 * Read the certificate an https provider presents, without sending it anything: a TLS handshake to the same
 * reviewed address providerFetch would use, then close. The certificate is not trusted by this call; the attestor
 * decides whether to pin it (providers/tls-pin.ts).
 */
const PEEK_DEADLINE_MS = 15_000;
export async function peekProviderCertificate(input: string | URL, policy: NetworkPolicy, signal?: AbortSignal): Promise<Buffer> {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Only https providers present a certificate.");
  const { host, literalFamily, pinned } = await resolveDestination(url, policy, signal);
  return await new Promise<Buffer>((resolve, reject) => {
    const socket = tlsConnect({
      host: pinned.address,
      port: Number(url.port || 443),
      ...(literalFamily === 0 ? { servername: host } : {}),
      // Nothing is sent over this connection; the certificate is only read.
      rejectUnauthorized: false,
    });
    // R4-01: a handshake that never completes ends at a deadline, with or without a signal.
    const timer = setTimeout(() => done(new DeadlineError("Reading the provider's certificate", PEEK_DEADLINE_MS)), PEEK_DEADLINE_MS);
    const done = (err: Error | null, der?: Buffer) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (err) reject(err);
      else resolve(der!);
    };
    const abort = () => done(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      done(raw && raw.length ? null : new Error("Provider presented no certificate."), raw ? Buffer.from(raw) : undefined);
    });
    // "on", not "once": a failed connect can emit more than one error, and an unhandled one crashes the process.
    socket.on("error", (e: Error) => done(e));
  });
}

/**
 * Errors of exchanges that ended BEFORE the request was written (resolution, connect, TLS, a deadline or an abort in
 * those phases). The provider never had such a request, so it cannot bill it: callers that bill a timed-out call
 * (providers/upstream.ts, security review R5-01) check here first.
 */
export const neverSent = new WeakSet<object>();

/**
 * One HTTP/1.1 exchange with a provider, on a socket this module opens itself.
 *
 * Why not node:http(s).request (security review round 4):
 *   R4-01  under the pinned runtime an abort before the response headers closed the socket and emitted nothing, so the
 *          call never returned. Here the deadline and the caller's signal are raced explicitly: either destroys the
 *          socket and settles the call (before the headers by rejecting, after them by failing the body stream).
 *   R4-05  the runtime ran the TLS identity check after the request had been written, so a server with a CA-valid
 *          certificate and the wrong key received the prompt and the gateway API key. Here the socket is connected to
 *          the one reviewed address, the handshake completes, the chain, the host name and the pinned key are checked
 *          on that socket, and only then is the first byte of the request written to it. Nothing is sent on a
 *          connection that failed a check.
 * One connection per call (`connection: close`): no pooling, so a response can never be read from another request's
 * connection. The cost is a handshake per call; pooling was rejected as the less safe design for the launch.
 */
export async function providerFetch(input: string | URL, init: RequestInit = {}, policy: NetworkPolicy): Promise<Response> {
  const url = new URL(input);
  if (init.redirect && init.redirect !== "error") throw new Error("Provider redirects are disabled.");
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && !(body instanceof URLSearchParams))
    throw new Error("Provider request body type is not supported.");
  const payload = body == null ? Buffer.alloc(0) : body instanceof ArrayBuffer ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body.toString(), "utf8");
  const method = (init.method ?? "GET").toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new Error("Provider request method is not valid.");
  const signal = init.signal ?? null;
  const deadlineMs = policy.deadlineMs ?? DEFAULT_DEADLINE_MS;

  return await new Promise<Response>((resolve, reject) => {
    let socket: Socket | TLSSocket | null = null;
    let settled = false; // the headers promise
    let failBody: ((e: Error) => void) | null = null; // set once the body stream exists
    let finished = false; // the whole exchange
    let sent = false; // the request left this process (R5-01: before that, the provider has nothing it could bill)
    let bodyTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(headerTimer);
      clearTimeout(totalTimer);
      clearTimeout(bodyTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    /** End the exchange with an error, in whichever phase it is: destroy the socket, settle the caller. */
    const fail = (e: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      socket?.destroy();
      if (!sent && e && typeof e === "object") neverSent.add(e);
      if (!settled) {
        settled = true;
        reject(e);
      } else failBody?.(e);
    };
    const done = () => {
      if (finished) return;
      finished = true;
      cleanup();
      socket?.destroy();
    };
    const onAbort = () => fail(abortReason(signal!));
    const headerTimer = setTimeout(() => fail(new DeadlineError("The provider call", deadlineMs)), deadlineMs);
    const totalTimer = policy.totalMs ? setTimeout(() => fail(new DeadlineError("The provider exchange", policy.totalMs!)), policy.totalMs) : undefined;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    resolveDestination(url, policy, signal).then(({ host, literalFamily, pinned }) => {
      if (finished) return;
      const https = url.protocol === "https:";
      const port = Number(url.port || (https ? 443 : 80));
      const pin = https ? policy.tlsPin ?? null : null;
      // One PEM bundle: the runtime reads a single string of several certificates, not every element of an array.
      const extraCa = !policy.production && developmentCa.length ? developmentCa.join("\n") : null;
      const send = () => {
        if (finished) return;
        const headers = new Headers(init.headers);
        // Compressed responses are not decoded here: request identity and fail closed if an upstream ignores it.
        headers.set("accept-encoding", "identity");
        headers.set("host", url.host);
        headers.set("connection", "close");
        headers.delete("transfer-encoding");
        if (payload.length || (method !== "GET" && method !== "HEAD")) headers.set("content-length", String(payload.length));
        else headers.delete("content-length");
        let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
        for (const [name, value] of headers) {
          if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) return fail(new Error("Provider request header is not valid."));
          head += `${name}: ${value}\r\n`;
        }
        // One write: the head and the body leave together (headers are byte strings, so latin1 is exact).
        sent = true;
        socket!.write(Buffer.concat([Buffer.from(head + "\r\n", "latin1"), payload]));
        readResponse(socket!, method, {
          headers: (res) => {
            if (finished) return;
            clearTimeout(headerTimer);
            // R5-13: a caller that passed no signal (and no `totalMs`) has nothing that ends a body which stalls after
            // the headers, so the body gets the deadline again, counted from the headers. `fail` is a no-op once the
            // exchange is finished, and `cleanup` clears the timer. A caller with a signal bounds its own body.
            if (!signal && !policy.totalMs) bodyTimer = setTimeout(() => fail(new DeadlineError("Reading the provider's response", deadlineMs)), deadlineMs);
            settled = true;
            failBody = res.fail;
            resolve(res.response);
          },
          end: done,
          error: fail,
          cancelled: done,
        });
      };
      if (!https) {
        socket = netConnect({ host: pinned.address, port, family: pinned.family });
        socket.once("connect", send);
      } else {
        const tls = tlsConnect({
          host: pinned.address,
          port,
          ...(literalFamily === 0 ? { servername: host } : {}),
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: true,
          // A certificate pin makes the attested certificate the only trust anchor; a key pin keeps the public CAs.
          ...(pin && !pin.spkiOnly ? { ca: pin.certPem } : extraCa ? { ca: extraCa } : {}),
          // The identity is checked below, explicitly, before anything is written: not left to the runtime's ordering.
          checkServerIdentity: () => undefined,
        });
        socket = tls;
        tls.once("secureConnect", () => {
          if (finished) return;
          const problem = verifyPeer(tls, host, pin);
          if (problem) return fail(problem);
          send();
        });
      }
      // "on", not "once": a failed connect can emit more than one error, and an unhandled one crashes the process.
      socket.on("error", (e: Error) => fail(e));
      socket.on("close", () => {
        if (!settled) fail(new Error("The provider closed the connection before answering."));
      });
    }, fail);
  });
}

/**
 * The checks a TLS connection must pass before any request byte is written to it: a chain the trust anchors accept,
 * and then either the pinned certificate's key (the endpoint's identity is its attested key, so the host name is not
 * checked), or the host name and, for a key pin, that key.
 */
function verifyPeer(tls: TLSSocket, host: string, pin: NetworkPolicy["tlsPin"]): Error | null {
  if (!tls.authorized) return new Error(`The provider's TLS certificate was not accepted${tls.authorizationError ? ` (${String(tls.authorizationError)})` : ""}.`);
  const cert = tls.getPeerCertificate(true);
  if (!cert?.raw?.length) return new Error("The provider presented no TLS certificate.");
  let spki: string;
  try {
    spki = spkiSha256Of(cert.raw);
  } catch {
    return new Error("The provider's TLS certificate could not be read.");
  }
  if (pin && !pin.spkiOnly) return spki === pin.spkiSha256 ? null : new Error("The provider's TLS key is not the attested key.");
  const named = checkServerIdentity(host, cert);
  if (named) return named;
  if (pin && spki !== pin.spkiSha256) return new Error("The provider's TLS key is not the attested key.");
  return null;
}

type ResponseEvents = { headers: (r: { response: Response; fail: (e: Error) => void }) => void; end: () => void; error: (e: Error) => void; cancelled: () => void };

/** Parse one HTTP/1.1 response from `socket`: the head (bounded), then the body as a stream with back-pressure. */
function readResponse(socket: Socket, method: string, on: ResponseEvents) {
  let head: Buffer[] = [];
  let headBytes = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let ended = false;
  // Body framing state.
  let mode: "head" | "length" | "chunked" | "close" | "done" = "head";
  let remaining = 0; // bytes left of a length-framed body or of the current chunk
  let chunkState: "size" | "data" | "crlf" | "trailers" = "size";
  let line = ""; // a partial chunk-size or trailer line
  // The body is handed to its reader from `pull` only: bytes wait in `queue` (the socket is paused while more than
  // QUEUE_HIGH_WATER are waiting), and a pull that finds it empty waits for the next bytes or the end. Nothing depends
  // on when the runtime chooses to call `pull` again after an enqueue made outside it.
  const queue: Buffer[] = [];
  let queued = 0;
  let complete = false; // the whole body was received
  let wake: (() => void) | null = null;
  const finish = () => {
    if (ended) return;
    ended = true;
    mode = "done";
    complete = true;
    wake?.();
    on.end();
  };
  const bad = (message: string) => {
    if (ended) return;
    ended = true;
    on.error(Object.assign(new Error(message), { errorKind: "unreadable" }));
  };
  const push = (bytes: Buffer) => {
    if (!bytes.length) return;
    queue.push(Buffer.from(bytes)); // a copy: the socket reuses its buffer
    queued += bytes.length;
    if (queued > QUEUE_HIGH_WATER) socket.pause();
    wake?.();
  };
  const body = (data: Buffer) => {
    let at = 0;
    while (at < data.length && !ended) {
      if (mode === "close") return push(data.subarray(at));
      if (mode === "length") {
        const take = Math.min(remaining, data.length - at);
        push(data.subarray(at, at + take));
        at += take;
        remaining -= take;
        if (remaining === 0) return finish();
        continue;
      }
      // chunked
      if (chunkState === "data") {
        const take = Math.min(remaining, data.length - at);
        push(data.subarray(at, at + take));
        at += take;
        remaining -= take;
        if (remaining === 0) chunkState = "crlf";
        continue;
      }
      const nl = data.indexOf(0x0a, at);
      const piece = data.subarray(at, nl < 0 ? data.length : nl).toString("latin1");
      line += piece;
      if (line.length > 4096) return bad("Provider sent a malformed chunked response.");
      if (nl < 0) return;
      at = nl + 1;
      const text = line.replace(/\r$/, "");
      line = "";
      if (chunkState === "crlf") {
        if (text !== "") return bad("Provider sent a malformed chunked response.");
        chunkState = "size";
      } else if (chunkState === "size") {
        const hex = text.split(";", 1)[0]!.trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) return bad("Provider sent a malformed chunked response.");
        remaining = Number.parseInt(hex, 16);
        chunkState = remaining === 0 ? "trailers" : "data";
      } else if (text === "") return finish(); // end of trailers
    }
  };
  const startBody = (statusCode: number, statusText: string, headers: Headers, rest: Buffer) => {
    const encoding = (headers.get("content-encoding") ?? "").toLowerCase();
    if (encoding && encoding !== "identity") return bad(`Provider sent ${encoding} despite Accept-Encoding: identity.`);
    const noBody = method === "HEAD" || statusCode === 204 || statusCode === 205 || statusCode === 304;
    const te = (headers.get("transfer-encoding") ?? "").toLowerCase();
    const cl = headers.get("content-length");
    // R5-13: a response frames its body one way. Both headers together is what request smuggling is made of; no sender may do it.
    if (te && cl !== null) return bad("Provider sent both Content-Length and Transfer-Encoding.");
    if (!noBody) {
      if (te) {
        if (te.split(",").map((x) => x.trim()).at(-1) !== "chunked") return bad("Provider sent an unsupported transfer encoding.");
        mode = "chunked";
      } else if (cl !== null) {
        if (!/^\d{1,15}$/.test(cl.trim())) return bad("Provider sent an invalid content length.");
        remaining = Number(cl.trim());
        mode = "length";
      } else mode = "close";
    }
    let failed: Error | null = null;
    const stream = noBody || (mode === "length" && remaining === 0) ? null : new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      async pull(c) {
        while (!queue.length && !complete && !failed) {
          socket.resume();
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
        if (failed) return c.error(failed);
        const next = queue.shift();
        if (next) {
          queued -= next.length;
          c.enqueue(new Uint8Array(next.buffer, next.byteOffset, next.byteLength));
          if (queued <= QUEUE_HIGH_WATER && !complete) socket.resume();
        }
        if (!queue.length && complete) c.close();
      },
      cancel() { if (!ended) { ended = true; on.cancelled(); } wake?.(); },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { status: statusCode, statusText, headers });
    on.headers({ response, fail: (e) => { failed = e; ended = true; wake?.(); if (!wake) { try { controller?.error(e); } catch { /* reader gone */ } } } });
    if (!stream) return finish();
    if (failed) return;
    if (rest.length) body(rest);
  };
  // R5-13: interim (1xx) responses are skipped in a loop over views of one buffer (no recursion, no copy per response),
  // and an exchange may carry at most MAX_INTERIM_RESPONSES of them.
  let interim = 0;
  const onData = (data: Buffer) => {
    if (ended) return;
    if (mode !== "head") return body(data);
    head.push(data);
    headBytes += data.length;
    let all = head.length === 1 ? head[0]! : Buffer.concat(head, headBytes);
    for (;;) {
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) {
        if (all.length > MAX_HEADER_BYTES) return bad("Provider response headers exceed the size limit.");
        // The unfinished head waits for more bytes. After an interim response it is a view of this event's buffer: keep a copy.
        head = [interim ? Buffer.from(all) : all];
        headBytes = all.length;
        return;
      }
      if (end > MAX_HEADER_BYTES) return bad("Provider response headers exceed the size limit.");
      const lines = all.subarray(0, end).toString("latin1").split("\r\n");
      const rest = all.subarray(end + 4);
      const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
      if (!status) return bad("Provider sent a malformed HTTP response.");
      const statusCode = Number(status[1]);
      if (statusCode === 101 || statusCode > 599) return bad("Provider sent an unsupported HTTP status.");
      if (statusCode < 200) {
        // An interim response (100 Continue, 103 Early Hints): skip it and read the next head.
        if (++interim > MAX_INTERIM_RESPONSES) return bad("Provider sent too many interim responses.");
        all = rest;
        continue;
      }
      const headers = new Headers();
      for (const l of lines.slice(1)) {
        const colon = l.indexOf(":");
        if (colon <= 0 || /^[ \t]/.test(l)) return bad("Provider sent a malformed HTTP header.");
        try {
          headers.append(l.slice(0, colon).trim(), l.slice(colon + 1).trim());
        } catch {
          return bad("Provider sent a malformed HTTP header.");
        }
      }
      head = [];
      headBytes = 0;
      return startBody(statusCode, status[2] ?? "", headers, rest);
    }
  };
  socket.on("data", onData);
  socket.on("end", () => {
    if (ended) return;
    if (mode === "close") return finish();
    bad(mode === "head" ? "The provider closed the connection before answering." : "The provider closed the connection before the response was complete.");
  });
  // A connection torn down without a clean end (a reset): the body is over, and unless it was close-framed, incomplete.
  socket.on("close", () => {
    if (ended) return;
    if (mode === "close") return finish();
    bad(mode === "head" ? "The provider closed the connection before answering." : "The provider closed the connection before the response was complete.");
  });
}
