import { deadlineFetch } from "../lib/deadline.ts";
/** One JSON-RPC exchange, body included (R4-01). */
export const RPC_DEADLINE_MS = 30_000;
const RPC_MAX_BYTES = 64 * 1024 * 1024;
import { Connection, Transaction, type Commitment, type ConfirmedSignatureInfo, type Finality, type Signer, type TransactionSignature, type VersionedTransaction } from "@solana/web3.js";
import { createRpcRedactor, redactRpcError } from "./rpc-redaction.ts";

// The router's single RPC layer: a Connection built from config, bounded retries with backoff, signature paging and a
// confirmation helper. Transactions are sent plainly through the configured RPC (no Jito bundles, no priority
// marketplaces). Private RPC URLs never reach logs or errors: every failure is passed through the redactor.

export type RpcSettings = { rpcUrl: string; rpcFallbackUrls?: readonly string[]; commitment?: Commitment };
export type RetryOptions = { attempts?: number; baseMs?: number; maxMs?: number; retryOn?: (e: unknown) => boolean };

const DEFAULT_RETRY: Required<RetryOptions> = {
  attempts: 4,
  baseMs: 250,
  maxMs: 4_000,
  // Network and rate-limit failures retry; a transaction the cluster rejected does not.
  retryOn: (e) => {
    const msg = String((e as Error)?.message ?? e);
    return /429|rate limit|ECONN|ETIMEDOUT|fetch failed|socket|timeout|503|502|Too many requests|Node is behind|blockhash not found/i.test(msg) && !/custom program error|InstructionError|already been processed/i.test(msg);
  },
};

/** Run `fn` with exponential backoff; the last error is rethrown with RPC URLs redacted. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}, redact: (e: unknown) => unknown = (e) => redactRpcError(e)): Promise<T> {
  const o = { ...DEFAULT_RETRY, ...opts };
  let lastError: unknown;
  for (let attempt = 0; attempt < o.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = redact(e);
      if (attempt === o.attempts - 1 || !o.retryOn(e)) break;
      const delay = Math.min(o.maxMs, o.baseMs * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** A Connection on the primary RPC URL. `commitment` defaults to confirmed; finalized is the deposit-crediting level. */
export function createConnection(settings: RpcSettings): Connection {
  // R4-01: every RPC call is raced against an explicit timer, body included; the address is never part of an error.
  const rpcFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => deadlineFetch(input as string | URL, init ?? {}, { ms: RPC_DEADLINE_MS, what: "The Solana RPC call", maxBytes: RPC_MAX_BYTES })) as typeof fetch;
  return new Connection(settings.rpcUrl, { commitment: settings.commitment ?? "confirmed", disableRetryOnRateLimit: true, fetch: rpcFetch as never });
}

/** A redactor for every URL this router knows, for callers that wrap their own errors. */
export const rpcRedactorFor = (settings: RpcSettings) => createRpcRedactor([settings.rpcUrl, ...(settings.rpcFallbackUrls ?? [])]);

/** The subset of Connection the indexers and senders use; tests pass a fake. */
export type RpcLike = Pick<Connection, "getSignaturesForAddress" | "getTransaction" | "getAccountInfo" | "getMultipleAccountsInfo" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction" | "getSlot" | "getBlockTime" | "getBlock" | "getSignatureStatuses" | "isBlockhashValid" | "getBalance" | "simulateTransaction"> & Partial<Pick<Connection, "getAddressLookupTable">>;

/** Pages a signature walk may take before it gives up (1000 signatures each): 1,000,000 signatures since the cursor. */
export const DEFAULT_MAX_SIGNATURE_PAGES = 1_000;

/**
 * A signature walk stopped at its page limit before it reached `until` (or the start of the address's history): older
 * signatures exist that were not read. A caller that advanced its cursor now would skip them for good (TR-16), so the
 * pass must fail instead.
 */
export class SignaturePageLimitError extends Error {
  readonly code = "signature_page_limit";
  constructor(readonly address: string, readonly pages: number, readonly read: number) {
    super(`signature paging for ${address} stopped after ${pages} pages (${read} signatures) without reaching the cursor`);
    this.name = "SignaturePageLimitError";
  }
}
export const isSignaturePageLimit = (e: unknown): e is SignaturePageLimitError => e instanceof SignaturePageLimitError;

/**
 * Walk `getSignaturesForAddress` newest-first in pages of `limit`, stopping at `until` (exclusive) or when the cluster
 * returns no more. Yields each page; the caller decides the order to process (usually reversed, oldest first) and may
 * stop early. When `maxPages` full pages have been yielded and the caller still wants more, the walk has not reached
 * `until`: it throws SignaturePageLimitError rather than ending as if the history were complete.
 */
export async function* pageSignatures(rpc: Pick<RpcLike, "getSignaturesForAddress">, address: import("@solana/web3.js").PublicKey, opts: { until?: string; limit?: number; commitment?: Finality; maxPages?: number } = {}): AsyncGenerator<ConfirmedSignatureInfo[]> {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 1000));
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_SIGNATURE_PAGES);
  let before: string | undefined;
  let read = 0;
  for (let page = 0; page < maxPages; page++) {
    const batch = await withRetry(() => rpc.getSignaturesForAddress(address, { before, until: opts.until, limit }, opts.commitment ?? "confirmed"));
    if (!batch.length) return;
    read += batch.length;
    yield batch;
    if (batch.length < limit) return;
    before = batch[batch.length - 1].signature;
  }
  throw new SignaturePageLimitError(address.toBase58(), maxPages, read);
}

export type SignatureWindow = {
  /** The oldest signatures newer than `until` (at most `keep`), oldest first: what a cursor-driven pass processes next. */
  signatures: ConfirmedSignatureInfo[];
  /** The walk reached `until` (or the start of the history). False: the page limit stopped it and `signatures` is empty. */
  complete: boolean;
  /** How many signatures newer than `until` the walk saw in all (the backlog). */
  total: number;
  pages: number;
};

/**
 * The OLDEST `keep` signatures newer than `until`, oldest first. The walk always goes the whole way back to `until`
 * (keeping only the far end in memory), so a caller that processes the window in order and moves its cursor to the last
 * one it processed never steps over a signature it has not seen, however long the backlog. If the page limit stops the
 * walk first, the result is `complete: false` with no signatures: nothing may be processed and the cursor must stay.
 */
export async function oldestSignaturesSince(rpc: Pick<RpcLike, "getSignaturesForAddress">, address: import("@solana/web3.js").PublicKey, until: string | undefined, opts: { keep?: number; limit?: number; commitment?: Finality; maxPages?: number } = {}): Promise<SignatureWindow> {
  const keep = Math.max(1, opts.keep ?? Number.MAX_SAFE_INTEGER);
  let tail: ConfirmedSignatureInfo[] = []; // newest first; trimmed to the oldest `keep`
  let total = 0, pages = 0;
  try {
    for await (const page of pageSignatures(rpc, address, { until, limit: opts.limit, commitment: opts.commitment, maxPages: opts.maxPages })) {
      pages++;
      total += page.length;
      tail = tail.length + page.length <= keep ? tail.concat(page) : tail.concat(page).slice(-keep);
    }
  } catch (e) {
    if (!isSignaturePageLimit(e)) throw e;
    return { signatures: [], complete: false, total: e.read, pages: e.pages };
  }
  return { signatures: tail.reverse(), complete: true, total, pages };
}

/**
 * Where a signature walk that did not fit one pass stands (persisted by the caller with its cursor). `head` is the
 * newest signature there was when the walk began; `bounds` are the last signatures of the full pages read so far, newest
 * page first; `discovered` says the walk has reached the cursor. One entry per 1,000 signatures: a backlog of a million
 * is a thousand short strings, not a million rows.
 */
export type SignatureWalk = { head: { signature: string; slot: number; err: unknown }; bounds: string[]; discovered: boolean };

export type SignatureBatch = {
  /** The oldest signatures newer than the cursor that are known in order, oldest first. Empty while the walk is still looking for the cursor. */
  signatures: ConfirmedSignatureInfo[];
  /** What to persist: null when no walk is in progress. */
  walk: SignatureWalk | null;
  pages: number;
  /** True while the walk has not reached the cursor yet (nothing can be processed in order). */
  discovering: boolean;
};

/**
 * The next signatures to process after `cursor`, oldest first, with BOUNDED work per call (at most `maxPages` requests)
 * however long the backlog is (security re-review RR-08). getSignaturesForAddress only pages backwards, so when the
 * backlog does not fit one page the walk towards the cursor is spread over calls and its position is kept in `walk`:
 *
 *   discovery   page back from the newest signature (the `head`), remembering each full page's last signature
 *               (`bounds`), until a short page shows the cursor was reached. That last page is the oldest segment and
 *               is returned at once.
 *   drain       each call returns the segment older than the last bound (one page, newer than the cursor); when it is
 *               empty the bound is dropped and the next segment follows. With no bound left, what remains is the newest
 *               page: everything between the cursor and the head, and the head itself. Once the cursor is the head the
 *               walk is over, and whatever arrived meanwhile is simply the next read.
 *
 * The caller processes the returned signatures in order, moves its cursor to the last one it finished, and stores
 * `walk`. It may stop early: the same segment is offered again, minus what the cursor has passed. Nothing is ever
 * returned out of order and no signature between the cursor and a returned one is skipped, so a cursor driven by this
 * never steps over a signature it has not seen (TR-16), and it never gives up either: there is no page limit to hit.
 */
export async function nextSignatureBatch(rpc: Pick<RpcLike, "getSignaturesForAddress">, address: import("@solana/web3.js").PublicKey, cursor: string | undefined, walk: SignatureWalk | null, opts: { limit?: number; commitment?: Finality; maxPages?: number } = {}): Promise<SignatureBatch> {
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 1000));
  const maxPages = Math.max(1, opts.maxPages ?? 20);
  const commitment = opts.commitment ?? "confirmed";
  const page = (before: string | undefined) => withRetry(() => rpc.getSignaturesForAddress(address, { before, until: cursor, limit }, commitment));
  let state: SignatureWalk | null = walk ? { head: walk.head, bounds: [...walk.bounds], discovered: walk.discovered } : null;
  let pages = 0;
  while (pages < maxPages) {
    if (state?.discovered) {
      if (state.bounds.length) {
        const segment = await page(state.bounds[state.bounds.length - 1]);
        pages++;
        if (!segment.length) { state.bounds.pop(); continue; }
        return { signatures: segment.reverse(), walk: state, pages, discovering: false };
      }
      // The newest page: what lies between the cursor and the head, then the head itself.
      if (cursor === state.head.signature) { state = null; continue; }
      const newest = await page(state.head.signature);
      pages++;
      const head = { signature: state.head.signature, slot: state.head.slot, err: state.head.err ?? null, memo: null, blockTime: null } as ConfirmedSignatureInfo;
      return { signatures: [...newest.reverse(), head], walk: state, pages, discovering: false };
    }
    const batch = await page(state ? state.bounds[state.bounds.length - 1] : undefined);
    pages++;
    if (batch.length < limit) {
      // The cursor (or the start of the address's history) is inside this page: it is the oldest segment.
      if (!state) return { signatures: batch.reverse(), walk: null, pages, discovering: false };
      state.discovered = true;
      if (batch.length) return { signatures: batch.reverse(), walk: state, pages, discovering: false };
      continue;
    }
    state ??= { head: { signature: batch[0]!.signature, slot: batch[0]!.slot, err: batch[0]!.err ?? null }, bounds: [], discovered: false };
    state.bounds.push(batch[batch.length - 1]!.signature);
  }
  return { signatures: [], walk: state, pages, discovering: !!state && !state.discovered };
}

/**
 * Every signature newer than `until`, oldest first. Throws SignaturePageLimitError when the walk cannot reach `until`
 * within `maxPages`: a partial list would let the caller's cursor jump over what was not read.
 */
export async function signaturesSince(rpc: Pick<RpcLike, "getSignaturesForAddress">, address: import("@solana/web3.js").PublicKey, until: string | undefined, opts: { limit?: number; commitment?: Finality; maxPages?: number } = {}) {
  const pages: ConfirmedSignatureInfo[] = [];
  for await (const page of pageSignatures(rpc, address, { ...opts, until })) pages.push(...page);
  return pages.reverse();
}

/**
 * The latest `limit` signatures of an address (one page), oldest first: a bounded look at recent history, not a cursor
 * walk, so there is nothing to step over and no page limit to hit.
 */
export async function recentSignatures(rpc: Pick<RpcLike, "getSignaturesForAddress">, address: import("@solana/web3.js").PublicKey, limit: number, commitment: Finality = "confirmed") {
  const batch = await withRetry(() => rpc.getSignaturesForAddress(address, { limit: Math.min(1000, Math.max(1, limit)) }, commitment));
  return [...batch].reverse();
}

export type SendResult = { signature: TransactionSignature; slot: number | null };

/** Sign (when signers are given), send and wait for `commitment`. Throws when the transaction landed with an error. */
export async function sendAndConfirm(rpc: Pick<RpcLike, "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction">, tx: Transaction | VersionedTransaction, signers: Signer[] = [], commitment: Commitment = "confirmed"): Promise<SendResult> {
  const { blockhash, lastValidBlockHeight } = await withRetry(() => rpc.getLatestBlockhash(commitment));
  if (tx instanceof Transaction) {
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    if (signers.length) tx.sign(...signers);
  } else if (signers.length) (tx as VersionedTransaction).sign(signers);
  const raw = tx.serialize();
  const signature = await withRetry(() => rpc.sendRawTransaction(Buffer.from(raw), { skipPreflight: false, preflightCommitment: commitment, maxRetries: 3 }));
  const slot = await confirmSignature(rpc, signature, { blockhash, lastValidBlockHeight }, commitment);
  return { signature, slot };
}

/** Wait for a signature; rejects with a redacted error when the transaction failed or the blockhash expired. */
export async function confirmSignature(rpc: Pick<RpcLike, "confirmTransaction">, signature: TransactionSignature, strategy: { blockhash: string; lastValidBlockHeight: number }, commitment: Commitment = "confirmed"): Promise<number | null> {
  const res = await rpc.confirmTransaction({ signature, ...strategy }, commitment).catch((e) => { throw redactRpcError(e); });
  if (res.value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return res.context?.slot ?? null;
}

/** The current slot and its block time, at `commitment`. */
export async function slotAndTime(rpc: Pick<RpcLike, "getSlot" | "getBlockTime">, commitment: Commitment = "confirmed") {
  const slot = await withRetry(() => rpc.getSlot(commitment));
  const time = (await withRetry(() => rpc.getBlockTime(slot))) ?? Math.floor(Date.now() / 1000);
  return { slot, time };
}

/** Whether a signature has landed (at `commitment`) and without error; null when the cluster does not know it. */
export async function signatureOutcome(rpc: Pick<RpcLike, "getSignatureStatuses">, signature: string): Promise<"success" | "failed" | null> {
  const { value } = await withRetry(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const s = value[0];
  if (!s) return null;
  return s.err ? "failed" : "success";
}
