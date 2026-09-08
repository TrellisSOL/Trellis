import {
  Trellis as CoreClient,
  TabSession,
  generateSessionKey,
  openTabTransaction,
  payPerCall,
  routingHeaders,
  signTransaction,
  canonicalJson,
  fetchTabAccount,
  holderVoteBody,
  holderVoteHeader,
  reclaimInstruction,
  signCreditClosure,
  signCreditClosureCancel,
  signRefundDestination,
  isClosureHeld,
  TrellisError,
  address as walletAddress,
  tabAddress,
  tabPdas,
  topUpInstruction,
  verifyReceiptV2,
  verifyVoucher,
  withRouting,
  type CreditClosure,
  type CreditClosureCancel,
  type CreditClosureRecord,
  type CreditClosureRelease,
  type DepositTransaction,
  type RefundDestinationTransaction,
  type HolderPoll,
  type HolderStatus,
  type HolderTiers,
  type HolderVote,
  type OpenTabOptions,
  type OpenTabTransaction,
  type PerCallPayer,
  type Signer,
  type TrellisMeta,
  type ChatBody,
  type ChatResult,
  type ChatStream,
  type ClientOptions as CoreOptions,
  type DisclosureMax,
  type Fetch,
  type KeySet,
  type Lane,
  type ReceiptV2Verification,
  type ReceiptVerification,
  type RequestOptions as CoreRequestOptions,
  type VerifyReceiptV2Options,
} from "@trellis/client";
import { TrellisAPIError, BatchTimeoutError, parseRetryAfter } from "./errors.js";
import { CREDITS_CLOSING, REFUND_DESTINATION_FIXED, REFUND_IN_PROGRESS } from "@trellis/client";
import { supportsLane } from "./lanes.js";
import {
  TERMINAL_BATCH_STATUSES,
  type Batch,
  type BatchList,
  type BatchResultLine,
  type CreateBatchParams,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type Model,
  type Preset,
  type PresetDoc,
  type PresetVersion,
  type Receipt,
  type RerankRequest,
  type RerankResponse,
  type ResponseMeta,
} from "./types.js";

export const DEFAULT_BASE_URL = "https://trellis.example";
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export type TrellisOptions = {
  /** Router API key. Default: the TRELLIS_API_KEY environment variable. */
  apiKey?: string;
  /** Router origin, with or without /api/v1. Default: TRELLIS_BASE_URL, then the public router. */
  baseUrl?: string;
  /** Default lane for every request (header X-Trellis-Lane and body provider.lane). */
  lane?: Lane;
  /** Default disclosure ceiling for every request. */
  disclosure?: DisclosureMax;
  headers?: Record<string, string>;
  fetch?: Fetch;
  /** Retries on 408, 409, 429 and 5xx, waiting for Retry-After when the router sends it. Default 2. */
  maxRetries?: number;
  /** Longest single wait between retries. Default 30 000 ms. */
  maxRetryDelayMs?: number;
  /** Check the signed receipt (v1 and, when present, v2) on every chat response. Default true. */
  verifyReceipts?: boolean;
  /** Throw when a chat receipt does not verify. Default false. */
  strictReceipts?: boolean;
  /** Pinned receipt keys: the well-known key set is then never fetched. */
  receiptKeys?: KeySet;
  /**
   * Pay per call with USDC on Solana instead of an API key: a 402 is answered once more with an x402 `exact`
   * payment signed by `payer.signer` (`X-PAYMENT`); the recent blockhash comes from `payer.rpcUrl` or
   * `payer.connection`. `payer.maxAmount` (USDC base units) caps what one call may cost.
   */
  payer?: PerCallPayer;
  /** Everything else @trellis/client takes (transparency log, blind tokens, ed25519 verifier, clock, X-Wallet-Auth). */
  core?: Partial<Omit<CoreOptions, "baseUrl" | "apiKey" | "fetch" | "lane" | "disclosure" | "headers" | "verifyReceipts" | "strictReceipts" | "receiptKeys" | "payer">>;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export type CallOptions = { lane?: Lane; disclosure?: DisclosureMax; headers?: Record<string, string>; signal?: AbortSignal };
export type ChatOptions = CoreRequestOptions;
export type ChatResponse = ChatResult & { trellis: TrellisMeta & { receiptV2Verification: ReceiptV2Verification | null } };
export type WithMeta<T> = T & { trellis: ResponseMeta };
export type ReceiptCheck = { valid: boolean; v1: ReceiptVerification | null; v2: ReceiptV2Verification | null };
export type ReceiptProof = { rid: string; leaf: string | null; leaf_version: 1 | 2; rooted: boolean; anchored: boolean; root?: string; proof?: string[]; status?: string; [k: string]: unknown };

const REFUNDS_RETURN = "A closure names no destination: what is left returns to the wallets that funded the key, and the API key cannot redirect it.";
/** `{ payer }` and nothing that names a destination: an older call (a destination string, refundTo, a second argument) fails here, before anything is sent. */
function payerOnly<T extends { payer: string }>(method: string, o: T, extra: unknown[]): T {
  const named = !!o && typeof o === "object" && ("refund_to" in o || "refundTo" in o);
  if (typeof o === "string" || named || extra.length)
    throw new TrellisError(`${method} takes only { payer }, the wallet that pays the transaction fee. ${REFUNDS_RETURN} A depositor moves its own refund destination with its wallet (credits.refundDestinationTx).`, REFUND_DESTINATION_FIXED);
  if (typeof o?.payer !== "string" || !o.payer) throw new TrellisError(`${method} needs { payer }: the wallet that pays the transaction fee. ${REFUNDS_RETURN}`, "bad_options");
  return o;
}
/** The signer forms (`credits.closeWith(payerSigner)`): a destination where the options go is an older call. */
function noDestination(method: string, o: unknown, extra: unknown[]): void {
  const named = !!o && typeof o === "object" && ("refund_to" in o || "refundTo" in o);
  if (typeof o === "string" || named || extra.length) throw new TrellisError(`${method} takes the payer's signer and nothing that names a destination. ${REFUNDS_RETURN}`, REFUND_DESTINATION_FIXED);
}

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;
const origin = (u: string) => u.replace(/\/+$/, "").replace(/\/(api\/)?v1$/, "");
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Trellis SDK. Chat goes through @trellis/client (receipt checks, attested lane, verify-before-send); the rest
 * of the API (embeddings, rerank, batches, presets, models, receipts) is plain JSON over the same fetch.
 */
export class Trellis {
  readonly baseUrl: string;
  /** The underlying @trellis/client instance: attestation, transparency log, blind tokens. */
  readonly core: CoreClient;
  private readonly opts: TrellisOptions;
  private readonly rawFetch: Fetch;
  private readonly apiKey: string | undefined;

  constructor(opts: TrellisOptions = {}) {
    this.opts = opts;
    this.apiKey = opts.apiKey ?? env("TRELLIS_API_KEY");
    this.baseUrl = origin(opts.baseUrl ?? env("TRELLIS_BASE_URL") ?? DEFAULT_BASE_URL);
    const base: Fetch = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.rawFetch = opts.payer ? payPerCall(base, opts.payer.signer, opts.payer) : base;
    this.core = new CoreClient({
      ...opts.core,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      fetch: (input, init) => this.send(String(input instanceof Request ? input.url : input), init),
      lane: opts.lane,
      disclosure: opts.disclosure,
      headers: opts.headers,
      verifyReceipts: opts.verifyReceipts,
      strictReceipts: opts.strictReceipts,
      receiptKeys: opts.receiptKeys,
    });
  }

  /** A copy of this client whose requests default to `lane` (and optionally a disclosure ceiling). */
  withLane(lane: Lane, disclosure?: DisclosureMax): Trellis {
    return new Trellis({ ...this.opts, apiKey: this.apiKey, baseUrl: this.baseUrl, lane, disclosure: disclosure ?? this.opts.disclosure });
  }

  // ---- transport --------------------------------------------------------------------------------------------------

  /** fetch with retries; a failed answer from the router's API becomes an {@link TrellisAPIError}. */
  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    const api = url.startsWith(`${this.baseUrl}/api/v1/`) && !url.startsWith(`${this.baseUrl}/api/v1/attestation`);
    const max = this.opts.maxRetries ?? 2;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      const res = await this.rawFetch(url, init);
      if (res.ok || !api) return res;
      // A 409 is retried as a conflict that may pass, except the ones that cannot: a key whose credits are being closed
      // is frozen until its refund is paid (409 credits_closing), and a closure that has started paying can no longer
      // be cancelled (409 refund_in_progress). Both are thrown as they arrive.
      const frozen = res.status === 409 && (await res.clone().json().then((j: { error?: { type?: string } }) => j?.error?.type === CREDITS_CLOSING || j?.error?.type === REFUND_IN_PROGRESS, () => false));
      if (attempt < max && RETRYABLE.has(res.status) && !frozen && !init.signal?.aborted) {
        const hinted = parseRetryAfter(res.headers.get("retry-after"));
        const wait = Math.min(this.opts.maxRetryDelayMs ?? 30_000, hinted ?? 500 * 2 ** attempt);
        await res.body?.cancel().catch(() => {});
        await sleep(wait);
        continue;
      }
      throw await TrellisAPIError.fromResponse(res);
    }
  }

  private headers(o: CallOptions = {}, json = false): Record<string, string> {
    return {
      accept: "application/json",
      ...(json ? { "content-type": "application/json" } : {}),
      ...this.opts.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...routingHeaders({ lane: o.lane ?? this.opts.lane, disclosure: o.disclosure ?? this.opts.disclosure }),
      ...o.headers,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown, o: CallOptions = {}): Promise<{ json: T; res: Response }> {
    const res = await this.send(`${this.baseUrl}${path}`, { method, signal: o.signal, headers: this.headers(o, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    return { json: (await res.json()) as T, res };
  }

  private async text(path: string, o: CallOptions = {}): Promise<string> {
    const res = await this.send(`${this.baseUrl}${path}`, { method: "GET", signal: o.signal, headers: { ...this.headers(o), accept: "application/jsonl, application/json, text/plain" } });
    return res.text();
  }

  /** Merge the lane and disclosure into body.provider without loosening a stricter value already there. */
  private routed<T extends Record<string, unknown>>(body: T, o: CallOptions): T {
    return withRouting(body, { lane: o.lane ?? this.opts.lane, disclosure: o.disclosure ?? this.opts.disclosure });
  }

  private meta(res: Response, receipt: Receipt | undefined | null): ResponseMeta {
    const h = res.headers;
    return {
      generationId: h.get("x-generation-id"),
      receiptId: h.get("x-receipt-id") ?? receipt?.id ?? null,
      lane: h.get("x-trellis-lane"),
      disclosure: h.get("x-trellis-disclosure"),
      policyHash: h.get("x-trellis-policy-hash"),
      receipt: receipt ?? null,
    };
  }

  // ---- chat -------------------------------------------------------------------------------------------------------

  readonly chat = {
    completions: {
      /** POST /api/v1/chat/completions. The receipt is checked (v1 and v2) unless verifyReceipts is false. */
      create: async (body: ChatBody, o: ChatOptions = {}): Promise<ChatResponse> => {
        const r = await this.core.chat.completions.create(body, o);
        const receipt = r.trellis.receipt as Receipt | null;
        const check = (o.verifyReceipt ?? this.opts.verifyReceipts ?? true) && receipt?.v2?.cose;
        const receiptV2Verification = check ? await verifyReceiptV2(receipt!.v2!.cose, { keys: await this.core.receiptKeys(), ed25519: this.opts.core?.ed25519 }) : null;
        return { ...r, trellis: { ...r.trellis, receiptV2Verification } };
      },
      /** Streamed chat. Iterate the chunks; then `meta()` has the receipt and `verifyChain()` checks the chunk chain. */
      stream: (body: ChatBody, o: ChatOptions = {}): Promise<ChatStream> => this.core.chat.completions.stream(body, o),
    },
  };

  // ---- embeddings and rerank --------------------------------------------------------------------------------------

  readonly embeddings = {
    /** POST /api/v1/embeddings. */
    create: async (body: EmbeddingsRequest, o: CallOptions = {}): Promise<WithMeta<EmbeddingsResponse>> => {
      const { json, res } = await this.request<EmbeddingsResponse>("POST", "/api/v1/embeddings", this.routed(body, o), o);
      return { ...json, trellis: this.meta(res, json.receipt) };
    },
  };

  readonly rerank = {
    /** POST /api/v1/rerank: results best first, each with the index of the document it scores. */
    create: async (body: RerankRequest, o: CallOptions = {}): Promise<WithMeta<RerankResponse>> => {
      const { json, res } = await this.request<RerankResponse>("POST", "/api/v1/rerank", this.routed(body, o), o);
      return { ...json, trellis: this.meta(res, json.receipt) };
    },
  };

  // ---- batches ----------------------------------------------------------------------------------------------------

  readonly batches = {
    /** Submit up to the router's line limit of chat or embeddings requests, run later at a discount. */
    create: async (params: CreateBatchParams, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("POST", "/api/v1/batches", params, o)).json,
    retrieve: async (id: string, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("GET", `/api/v1/batches/${encodeURIComponent(id)}`, undefined, o)).json,
    list: async (q: { limit?: number; after?: string } = {}, o: CallOptions = {}): Promise<BatchList> => {
      const qs = new URLSearchParams();
      if (q.limit) qs.set("limit", String(q.limit));
      if (q.after) qs.set("after", q.after);
      return (await this.request<BatchList>("GET", `/api/v1/batches${qs.size ? `?${qs}` : ""}`, undefined, o)).json;
    },
    cancel: async (id: string, o: CallOptions = {}): Promise<Batch> => (await this.request<Batch>("POST", `/api/v1/batches/${encodeURIComponent(id)}/cancel`, undefined, o)).json,
    /** Successful lines, parsed from JSONL. */
    output: async (id: string, o: CallOptions = {}): Promise<BatchResultLine[]> => parseJsonl(await this.text(`/api/v1/batches/${encodeURIComponent(id)}/output`, o)),
    /** Failed, cancelled and expired lines, parsed from JSONL. */
    errors: async (id: string, o: CallOptions = {}): Promise<BatchResultLine[]> => parseJsonl(await this.text(`/api/v1/batches/${encodeURIComponent(id)}/errors`, o)),
    /** Poll until the batch is completed, failed, expired or cancelled. */
    wait: async (id: string, w: { pollIntervalMs?: number; timeoutMs?: number; onPoll?: (b: Batch) => void; signal?: AbortSignal } = {}): Promise<Batch> => {
      const started = Date.now();
      const sleep = this.opts.sleep ?? defaultSleep;
      for (;;) {
        const b = await this.batches.retrieve(id, { signal: w.signal });
        w.onPoll?.(b);
        if (TERMINAL_BATCH_STATUSES.includes(b.status)) return b;
        if (w.timeoutMs != null && Date.now() - started >= w.timeoutMs) throw new BatchTimeoutError(id, b.status);
        await sleep(w.pollIntervalMs ?? 5_000);
      }
    },
    /** Wait for the batch, then return every line keyed by custom_id: `ok` holds answers, `failed` holds errors. */
    results: async (id: string, w: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) => {
      const batch = await this.batches.wait(id, w);
      const [ok, failed] = await Promise.all([this.batches.output(id, { signal: w.signal }), batch.request_counts.failed || batch.status !== "completed" ? this.batches.errors(id, { signal: w.signal }) : Promise.resolve([])]);
      return { batch, ok, failed, byCustomId: new Map([...ok, ...failed].map((l) => [l.custom_id ?? l.id, l])) };
    },
  };

  // ---- presets ----------------------------------------------------------------------------------------------------

  readonly presets = {
    list: async (o: CallOptions = {}): Promise<Preset[]> => (await this.request<{ data: Preset[] }>("GET", "/api/v1/presets", undefined, o)).json.data,
    /** A preset, or one of its versions (3, "v3" or a hash prefix). */
    get: async (name: string, version?: number | string, o: CallOptions = {}): Promise<Preset & { latest_version: number }> =>
      (await this.request<{ data: Preset & { latest_version: number } }>("GET", `/api/v1/presets/${encodeURIComponent(name)}${version != null ? `?version=${encodeURIComponent(String(version))}` : ""}`, undefined, o)).json.data,
    /** Create or update. A new version is written only when the config changed (`changed`). */
    put: async (name: string, doc: PresetDoc, o: CallOptions = {}): Promise<Preset & { changed: boolean }> => (await this.request<{ data: Preset & { changed: boolean } }>("PUT", `/api/v1/presets/${encodeURIComponent(name)}`, doc, o)).json.data,
    delete: async (name: string, o: CallOptions = {}): Promise<{ name: string; model: string; deleted: boolean; versions: number }> => (await this.request<{ data: { name: string; model: string; deleted: boolean; versions: number } }>("DELETE", `/api/v1/presets/${encodeURIComponent(name)}`, undefined, o)).json.data,
    versions: async (name: string, o: CallOptions = {}): Promise<PresetVersion[]> => (await this.request<{ data: PresetVersion[] }>("GET", `/api/v1/presets/${encodeURIComponent(name)}/versions`, undefined, o)).json.data,
    diff: async (name: string, from: number | string, to: number | string, o: CallOptions = {}) =>
      (await this.request<{ data: { name: string; from: PresetVersion; to: PresetVersion; identical: boolean; changes: unknown[] } }>("GET", `/api/v1/presets/${encodeURIComponent(name)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`, undefined, o)).json.data,
    rollback: async (name: string, version: number | string, o: CallOptions = {}): Promise<Preset & { changed: boolean; restored_from: number }> =>
      (await this.request<{ data: Preset & { changed: boolean; restored_from: number } }>("POST", `/api/v1/presets/${encodeURIComponent(name)}/rollback`, { version }, o)).json.data,
    /** The model string that runs a preset: "@preset/name" or "@preset/name@3". */
    model: (name: string, version?: number | string) => `@preset/${name}${version != null ? `@${version}` : ""}`,
  };

  // ---- models -----------------------------------------------------------------------------------------------------

  readonly models = {
    /** GET /api/v1/models, optionally only those servable on `lane` right now or with an output modality (e.g. "rerank"). */
    list: async (q: { lane?: Lane; outputModalities?: string; signal?: AbortSignal } = {}): Promise<Model[]> => {
      const qs = q.outputModalities ? `?output_modalities=${encodeURIComponent(q.outputModalities)}` : "";
      const { json } = await this.request<{ data: Model[] }>("GET", `/api/v1/models${qs}`, undefined, { signal: q.signal, lane: undefined });
      return q.lane ? json.data.filter((m) => supportsLane(m, q.lane!)) : json.data;
    },
    /** The live endpoints (providers) behind one model. */
    endpoints: async (id: string, o: CallOptions = {}) => (await this.request<{ data: Record<string, unknown> }>("GET", `/api/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`, undefined, o)).json.data,
  };

  // ---- holder tiers -----------------------------------------------------------------------------------------------

  /**
   * $TRLS holder tiers: membership levels with fixed thresholds. Their perks are access and priority (higher limits,
   * sealed-lane priority, early access to newly listed models, an advisory vote, credits that do not expire while the
   * tier is held, an opt-in profile badge). No tier changes a price. This is what the router returns today; it can change.
   */
  readonly holders = {
    /** GET /api/v1/holders/tiers: the tier table. `enabled: false` means holder tiers are not switched on yet. */
    tiers: async (o: CallOptions = {}): Promise<HolderTiers> => (await this.request<{ data: HolderTiers }>("GET", "/api/v1/holders/tiers", undefined, o)).json.data,
    /** GET /api/v1/holders/me: the tier of the wallet behind this key, the next threshold and the perks that apply now. */
    me: async (o: CallOptions = {}): Promise<HolderStatus> => (await this.request<{ data: HolderStatus }>("GET", "/api/v1/holders/me", undefined, o)).json.data,
    /** GET /api/v1/holders/polls: advisory polls, newest first; `status` keeps only open or only closed ones. */
    polls: async (q: { status?: "open" | "closed" } = {}, o: CallOptions = {}): Promise<HolderPoll[]> => (await this.request<{ data: HolderPoll[] }>("GET", `/api/v1/holders/polls${q.status ? `?status=${q.status}` : ""}`, undefined, o)).json.data,
    /** GET /api/v1/holders/polls/:id: one poll and its tally. */
    poll: async (id: string, o: CallOptions = {}): Promise<HolderPoll> => (await this.request<{ data: HolderPoll }>("GET", `/api/v1/holders/polls/${encodeURIComponent(id)}`, undefined, o)).json.data,
    /**
     * POST /api/v1/holders/polls/:id/vote: one advisory vote per wallet, signed by `signer` (the wallet that holds the
     * tier) with X-Wallet-Auth: the method, the router's host, the vote path, the time and the hash of the canonical
     * JSON body. The API key is not sent, and the request is sent once: a signature is single use, so a refusal
     * (not_a_holder, already_voted, poll_closed) is thrown as it arrives.
     */
    vote: async (pollId: string, option: string, signer: Signer, o: { signal?: AbortSignal } = {}): Promise<HolderVote> => {
      const body = canonicalJson(holderVoteBody(pollId, option));
      const res = await this.rawFetch(`${this.baseUrl}/api/v1/holders/polls/${encodeURIComponent(pollId)}/vote`, {
        method: "POST",
        signal: o.signal,
        headers: { accept: "application/json", "content-type": "application/json", ...this.opts.headers, "x-wallet-auth": await holderVoteHeader(signer, new URL(this.baseUrl).host, pollId, option) },
        body,
      });
      if (!res.ok) throw await TrellisAPIError.fromResponse(res);
      return ((await res.json()) as { data: HolderVote }).data;
    },
  };

  // ---- receipts ---------------------------------------------------------------------------------------------------

  readonly receipts = {
    /** GET /api/v1/receipts/:id: the v1 envelope, the v2 COSE receipt beside it, and the anchor once rooted. */
    get: async (id: string, o: CallOptions = {}): Promise<Receipt & { version: 1 | 2; privacy?: unknown }> => (await this.request<{ data: Receipt & { version: 1 | 2 } }>("GET", `/api/v1/receipts/${encodeURIComponent(id)}`, undefined, o)).json.data,
    /** GET /api/v1/receipts/:id/proof: the Merkle path once the hour has been rooted. */
    proof: async (id: string, version?: 1 | 2, o: CallOptions = {}): Promise<ReceiptProof> => (await this.request<{ data: ReceiptProof }>("GET", `/api/v1/receipts/${encodeURIComponent(id)}/proof${version === 1 ? "?v=1" : ""}`, undefined, o)).json.data,
    /** The router's published receipt keys (cached). */
    keys: (refresh = false): Promise<KeySet> => this.core.receiptKeys(refresh),
    /**
     * Check a receipt offline against the router's keys: the v1 Ed25519 signature, and the v2 COSE_Sign1 when present
     * (with the streamed chunks, hashes and anchor proof when you pass them).
     */
    verify: async (receipt: Receipt, v2: Omit<VerifyReceiptV2Options, "keys" | "publicKeyHex"> = {}): Promise<ReceiptCheck> => {
      const v1 = receipt.sig && receipt.payload ? await this.core.verifyReceipt(receipt) : null;
      const cose = receipt.v2?.cose;
      const v2r = cose ? await verifyReceiptV2(cose, { ed25519: this.opts.core?.ed25519, ...v2, keys: await this.core.receiptKeys() }) : null;
      return { valid: !!(v1 || v2r) && (v1?.valid ?? true) && (v2r?.valid ?? true), v1, v2: v2r };
    },
    /** Fetch a receipt by id and its proof, then verify both. */
    fetchAndVerify: async (id: string): Promise<ReceiptCheck & { receipt: Receipt }> => {
      const receipt = await this.receipts.get(id);
      const p = receipt.v2?.cose ? await this.receipts.proof(id).catch(() => null) : null;
      const proof = p?.root && p.proof ? { root: p.root, proof: p.proof, anchored: p.anchored } : null;
      return { ...(await this.receipts.verify(receipt, { proof })), receipt };
    },
  };

  // ---- credits (USDC on Solana) -------------------------------------------------------------------------------------

  readonly credits = {
    /**
     * POST /api/v1/credits/deposit-tx: an unsigned deposit transaction moving `amount` USDC (decimal string, up to 6
     * places) from `payer`'s wallet into this key's credits. Sign it with `signTransaction` (or a wallet adapter) and
     * send it; the key is credited once it is finalized. Credits are spend-only. `refund_to` in the answer is where
     * what is left of this deposit returns if the key's credits are ever closed: the token account it is paid from.
     */
    depositTx: async (amount: string, payer: string, o: CallOptions = {}): Promise<DepositTransaction> => (await this.request<{ data: DepositTransaction }>("POST", "/api/v1/credits/deposit-tx", { amount, payer }, o)).json.data,
    /**
     * POST /api/v1/credits/close: close this key's credits. What is left is paid back to the wallets that deposited
     * to the key (the answer's `refunds`), after the dispute window. There is no destination to pass: the API key
     * cannot choose or change where the refund goes, and a call that names one throws. `payer` is any wallet; it only
     * pays the fee. Call it with the key itself. The returned `transaction` ALREADY carries the key's signature; the
     * payer adds its own: `credits.signClosure(closure.transaction, payerSigner)`, then send it before
     * `expires_at_block_height`. `transaction` is null when the closure is already registered. From the moment it
     * lands the key is frozen: calls that would spend throw {@link CreditsClosingError} (409 `credits_closing`). Until
     * anything is paid it can be taken back with `credits.cancelClose`.
     */
    close: async (o: CallOptions & { payer: string }, ...legacy: never[]): Promise<CreditClosure> => {
      const { payer, ...call } = payerOnly("credits.close", o, legacy);
      return (await this.request<{ data: CreditClosure }>("POST", "/api/v1/credits/close", { payer }, call)).json.data;
    },
    /** Add the payer's signature to a closure transaction, leaving the key's signature as issued. Returns base64, ready to send. */
    signClosure: signCreditClosure,
    /** Request the closure with `payer` as fee payer and sign it: `signed` is the transaction to send (null when already registered). */
    closeWith: async (payer: Signer, o: CallOptions = {}, ...legacy: never[]): Promise<{ closure: CreditClosure; signed: string | null }> => {
      noDestination("credits.closeWith", o, legacy);
      const closure = await this.credits.close({ ...o, payer: walletAddress(payer.publicKey) });
      return { closure, signed: closure.transaction ? await signCreditClosure(closure.transaction, payer) : null };
    },
    /**
     * POST /api/v1/credits/close/cancel: take a closure back while nothing has been paid. Call it with the key itself;
     * the returned transaction already carries the key's signature and `payer` (any wallet) pays the fee. Once it
     * lands the key is open again with its balance. 400 `nothing_to_cancel` when no closure is on chain, 409
     * `refund_in_progress` once a payment was sent (never retried).
     * Who may cancel: whoever asked for the closure, or the key's registered owner wallet. The key itself only for a
     * closure the key asked for, and once in 60 days: 409 `cancel_cooldown` after that (error.metadata.retry_at), 403
     * `not_requester` for a closure the owner wallet asked for. A wallet that only deposited to the key cannot cancel.
     */
    cancelClose: async (o: CallOptions & { payer: string }, ...legacy: never[]): Promise<CreditClosureCancel> => {
      const { payer, ...call } = payerOnly("credits.cancelClose", o, legacy);
      return (await this.request<{ data: CreditClosureCancel }>("POST", "/api/v1/credits/close/cancel", { payer }, call)).json.data;
    },
    /** Add the payer's signature to a cancellation, leaving the key's signature as issued. Returns base64, ready to send. */
    signCancel: signCreditClosureCancel,
    /** Request the cancellation with `payer` as fee payer and sign it: `signed` is the transaction to send. */
    cancelCloseWith: async (payer: Signer, o: CallOptions = {}, ...legacy: never[]): Promise<{ cancel: CreditClosureCancel; signed: string }> => {
      noDestination("credits.cancelCloseWith", o, legacy);
      const cancel = await this.credits.cancelClose({ ...o, payer: walletAddress(payer.publicKey) });
      return { cancel, signed: await signCreditClosureCancel(cancel.transaction, payer) };
    },
    /**
     * POST /api/v1/credits/close/release: let a held closure go ahead. A closure is not paid while its key is disabled
     * (disabling a key stops a closure it started); an owner or admin of the account releases it on purpose, with
     * their own key. `keyHash` is the hash that names the closed key (as GET /api/v1/keys lists it), never the key
     * itself. The refund still only returns to the wallets that paid in.
     */
    releaseClose: async (keyHash: string, o: CallOptions = {}): Promise<CreditClosureRelease[]> => {
      if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new TrellisError("credits.releaseClose takes the key's hash (64 hex characters, as GET /api/v1/keys lists it), not the API key", "bad_options");
      return (await this.request<{ data: CreditClosureRelease[] }>("POST", "/api/v1/credits/close/release", { key: keyHash }, o)).json.data;
    },
    /**
     * POST /api/v1/credits/refund-destination-tx: an UNSIGNED transaction that moves where `depositor`'s own deposits
     * to this key are refunded, to `refundTo`'s USDC token account. Only the depositor's wallet can sign it
     * (`credits.signRefundDestination`); the API key cannot. It moves no money now. 404 when that wallet never
     * deposited to the key.
     */
    refundDestinationTx: async (depositor: string, refundTo: string, o: CallOptions = {}): Promise<RefundDestinationTransaction> =>
      (await this.request<{ data: RefundDestinationTransaction }>("POST", "/api/v1/credits/refund-destination-tx", { depositor, refund_to: refundTo }, o)).json.data,
    /** Sign a refund destination change with the depositor's own wallet (the only signer). Returns base64, ready to send. */
    signRefundDestination,
    /** Ask for the change with `depositor`'s address and sign it with that wallet: `signed` is the transaction to send. */
    setRefundDestinationWith: async (depositor: Signer, refundTo: string, o: CallOptions = {}): Promise<{ request: RefundDestinationTransaction; signed: string }> => {
      const request = await this.credits.refundDestinationTx(walletAddress(depositor.publicKey), refundTo, o);
      return { request, signed: await signRefundDestination(request.transaction, depositor) };
    },
    /** GET /api/v1/credits/close: this key's closures, newest first, with who is paid back (`refunds`). */
    closures: async (o: CallOptions = {}): Promise<CreditClosureRecord[]> => (await this.request<{ data: CreditClosureRecord[] }>("GET", "/api/v1/credits/close", undefined, o)).json.data,
    /** True for an open closure that is on hold because its key was disabled: an owner or admin releases it (`releaseClose`). */
    isHeld: isClosureHeld,
  };

  // ---- tabs (trellis_tab) --------------------------------------------------------------------------------------------

  readonly tabs = {
    /** The tab program id this router's facilitator settles (GET /facilitator/supported), or null when it has none. */
    programId: async (o: CallOptions = {}): Promise<string | null> => {
      const res = await this.send(`${this.baseUrl}/facilitator/supported`, { method: "GET", signal: o.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw await TrellisAPIError.fromResponse(res);
      const j = (await res.json()) as { kinds?: Array<{ scheme?: string; extra?: { program?: string } }> };
      return j.kinds?.find((k) => k.scheme === "tab")?.extra?.program ?? null;
    },
    /**
     * The open_tab transaction for the payer's wallet to sign and send (base64, fee payer = payer). The program id
     * defaults to the facilitator's. Generate `sessionKey` with `tabs.generateSessionKey()` and keep its secret key.
     */
    open: async (o: Omit<OpenTabOptions, "programId"> & { programId?: string; recentBlockhash: string }): Promise<OpenTabTransaction> => {
      const programId = o.programId ?? (await this.tabs.programId());
      if (!programId) throw new TrellisAPIError("This router's facilitator does not settle tabs (no tab program).", "tabs_unavailable", 503, undefined, new Headers());
      return openTabTransaction({ ...o, programId });
    },
    /**
     * The payer's voucher signer for an open tab: `session.voucher(cumulativeUsed)` gives the request headers. A
     * voucher is signed for the tab program and for this opening of the tab, so the session needs `programId` and the
     * tab's `createdAt` (`tabs.account(tab, rpc)` reads it once `open_tab` has landed; or use `tabs.resume`).
     */
    session: (o: ConstructorParameters<typeof TabSession>[0]) => new TabSession(o),
    /** A session for the tab as it is open on the cluster now: created_at, cap and posted counters come from the chain. */
    resume: async (o: Omit<Parameters<typeof TabSession.open>[0], "programId"> & { programId?: string }): Promise<TabSession> => {
      const programId = o.programId ?? (await this.tabs.programId());
      if (!programId) throw new TrellisAPIError("This router's facilitator does not settle tabs (no tab program).", "tabs_unavailable", 503, undefined, new Headers());
      return TabSession.open({ ...o, programId });
    },
    /** The open Tab account, decoded (null when there is none): `createdAt` is what vouchers sign. */
    account: fetchTabAccount,
    address: tabAddress,
    pdas: tabPdas,
    topUp: topUpInstruction,
    /** reclaim(): deliver an expired (or closed) tab's escrow to its payer and payee; needs nobody's signature. */
    reclaim: reclaimInstruction,
    generateSessionKey,
    signTransaction,
    verifyVoucher,
  };
}

export type { CreditClosure, CreditClosureCancel, CreditClosureRecord, CreditClosureRelease, DepositTransaction, PerCallPayer, RefundDestinationTransaction, Signer };

export function parseJsonl<T = BatchResultLine>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
