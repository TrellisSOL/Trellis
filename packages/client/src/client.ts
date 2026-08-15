import { agreementClient } from "./agreements.js";
import { agentClient } from "./agent.js";
import { playbookClient } from "./playbooks.js";
import { holderClient } from "./holders.js";
import { requestError } from "./agent-errors.js";
import { e2eeChat, type E2eeChatBody, type E2eeOptions } from "./e2ee.js";
import { verifyProvider, fetchRouterAttestation, type AttestFetcher, type ExpectedDigests, type ProviderVerification, type QuoteVerifier, type RouterAttestation } from "./attestation.js";
import type { Ed25519Verifier } from "./ed25519.js";
import { TrellisError, AttestationRefused, ReceiptInvalid, REFUND_DESTINATION_FIXED } from "./errors.js";
import { routingHeaders, withRouting, type DisclosureMax, type Lane } from "./options.js";
import { fetchReceiptKeys, verifyReceipt, type ReceiptVerification } from "./receipts.js";
import { checkChain, type ChainedEvent } from "./receipts-v2.js";
import { TransparencyLog, type TransparencyOptions } from "./tlog.js";
import { base64ToBytes } from "./bytes.js";
import { address as walletAddress, parsePaymentResponse, payPerCall, signCreditClosure, signCreditClosureCancel, signRefundDestination, walletAuthHeader, type PaymentResponse, type PerCallPayer, type Signer } from "./solana.js";
import type { Fetch, KeySet, ReceiptEnvelope } from "./types.js";

export type ClientOptions = {
  /** The router's base URL, for example https://router.example (the /api/v1 prefix is added). */
  baseUrl: string;
  /** A router API key, sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** A finished blind token, sent as `Authorization: PrivateToken token=...`. Takes the place of the API key on chat. */
  privateToken?: string;
  fetch?: Fetch;
  headers?: Record<string, string>;
  /** Default disclosure ceiling for every request. A per-request option can only tighten it. */
  disclosure?: DisclosureMax;
  /** Default lane for every request. */
  lane?: Lane;
  /** Check the signed receipt on every response (default true). The result is on `response.trellis.receipt`. */
  verifyReceipts?: boolean;
  /** Throw {@link ReceiptInvalid} when a receipt does not verify, instead of only reporting it. Default false. */
  strictReceipts?: boolean;
  /** Pinned router receipt keys. When set, the well-known key set is never fetched. */
  receiptKeys?: KeySet;
  ed25519?: Ed25519Verifier;
  /** Clock used for freshness checks (milliseconds). Defaults to Date.now; set it only to replay recorded evidence. */
  now?: () => number;
  /**
   * Opt-in split-view checks against the router's witnessed transparency log. When set, a receipt verifies only if its
   * signing key is logged under a checkpoint cosigned by `quorum` of `witnesses` and consistent with every checkpoint
   * this client saw before (check `key_logged`). `client.transparency` checks other keys (Oblivious HTTP key
   * configurations, blind-token issuer keys, sidecar bindings) the same way. With `rekor`, a verified Rekor anchor of the
   * checkpoint counts in place of the cosignatures (or besides them, when witnesses are listed too). Off by default.
   */
  transparency?: Omit<TransparencyOptions, "fetch" | "ed25519">;
  /**
   * Pay per call with USDC on Solana (no API key): a 402 from chat is answered once more with an x402 `exact` payment
   * signed by `payer.signer` (`X-PAYMENT`). The recent blockhash comes from `payer.rpcUrl` or `payer.connection`.
   * Unused value stays as change on the wallet's account; spend it with `walletAuth`.
   */
  payer?: PerCallPayer;
  /**
   * Sign every chat request with this wallet (`X-Wallet-Auth`), spending the change of earlier per-call payments. The
   * signature covers the request's method, the router's host, its path and the request hash, so it is good for that
   * one call only.
   */
  walletAuth?: Signer;
  /**
   * The router's public host as `X-Wallet-Auth` must name it, when it is not the host of `baseUrl` (a client that
   * reaches the router through another name). Default: the host of `baseUrl`.
   */
  walletAuthHost?: string;
};

/** POST /api/v1/credits/deposit-tx: an unsigned deposit transaction for the payer's wallet to sign and send. */
export type DepositTransaction = {
  /** Base64 unsigned legacy transaction, fee payer = payer. Sign with `signTransaction` or a wallet adapter. */
  transaction: string;
  message: string;
  network: string;
  amount_usdc: string;
  amount_units: string;
  /** `credit`, `vault`, `depositorToken` and `share` (the on-chain record of what this wallet put into the key). */
  accounts: Record<string, string>;
  /**
   * The token account a closure refund of this deposit returns to: the one it is paid from. Only the paying wallet can
   * change it ({@link Trellis.refundDestinationTx}); the API key cannot.
   */
  refund_to?: string;
  expires_at_block_height: number;
  key_hash: string;
  note?: string;
  [k: string]: unknown;
};

/** queued: the transaction was handed out. registered: it is on chain and the key is frozen. cancelled: taken back, the key is open again. */
export type CreditClosureStatus = "queued" | "registered" | "paid" | "refused" | "failed" | "cancelled";
/**
 * Why a closure is where it is. On an open closure (queued or registered) these mean it is waiting, not failed:
 * `key_disabled` (the key was disabled; held until an owner or admin releases it), `refund_rate_limited`,
 * `refund_destination_unavailable` (a depositor's token account cannot receive right now), `depositors_unknown`,
 * `submission_failed` (retried). `cancelled_on_chain` and `sanctioned_address` are final.
 */
export type CreditClosureReason = "key_disabled" | "refund_rate_limited" | "refund_destination_unavailable" | "depositors_unknown" | "cancelled_on_chain" | "sanctioned_address" | "submission_failed";

/**
 * Where a closure refund goes, one row per wallet that deposited to the key: `refund_to` is the token account that
 * wallet named on chain (by default the one it paid from), and it gets back at most `deposited_units` less what it was
 * already refunded. Nobody holding the API key can add a row or change one.
 */
export type ClosureRefund = { depositor: string; refund_to: string; deposited_units: string; refunded_units: string };

/** One payment of a closure refund, as GET /api/v1/credits/close lists it: `owner` is the wallet that owns `refund_to`. */
export type ClosureRefundPayment = {
  depositor: string;
  refund_to: string;
  owner: string | null;
  amount_units: string;
  status: "planned" | "paid" | "refused" | "reversed" | (string & {});
  reason: CreditClosureReason | (string & {}) | null;
  tx: string | null;
};

/**
 * The answer of POST /api/v1/credits/close. `transaction` is the close_account transaction, ALREADY signed by the API
 * key's own keypair (the router signs it from the bearer key and keeps neither): the `payer` wallet adds its signature
 * as fee payer with {@link signCreditClosure} and sends it before `expires_at_block_height`. It is null when the
 * closure is already registered on chain. Once it lands the key is frozen: calls that would spend answer 409
 * `credits_closing` until the refund is paid or the closure is cancelled.
 *
 * There is no destination to choose: `refunds` says where the money goes, which is back to the wallets that paid in.
 */
export type CreditClosure = {
  id: string;
  status: CreditClosureStatus | (string & {});
  /** The wallet that pays the fee and a small rent: the transaction's fee payer. It is not the refund's destination. */
  payer?: string;
  /** Same as `payer` (the older name of the field). */
  authority?: string;
  payable_at: string;
  transaction?: string | null;
  /** True when `transaction` carries the key's signature: only the payer still has to sign. False when it was asked for as the owner wallet. */
  signed_by_key?: boolean;
  /** Who the transaction asks as: the key, or the key's registered owner wallet (such a closure cannot be cancelled with the API key). */
  requested_by?: "key" | "owner" | null;
  /** The key's registered owner wallet, or null when none is registered. */
  owner?: string | null;
  message?: string | null;
  /** `refundRequest`: the on-chain record of the queued refund. */
  accounts?: Record<string, string> | null;
  expires_at_block_height?: number | null;
  /** Who is paid back and where. */
  refunds?: ClosureRefund[];
  note?: string;
  [k: string]: unknown;
};

/** One row of GET /api/v1/credits/close. */
export type CreditClosureRecord = {
  id: string;
  status: CreditClosureStatus | (string & {});
  reason: CreditClosureReason | (string & {}) | null;
  /** The wallets paid so far, comma-separated; null until something is paid. Never chosen by the key. */
  refund_to: string | null;
  /** The payment plan once it exists: one row per depositor. Empty before the delay has passed. */
  refunds: ClosureRefundPayment[];
  amount_units: string | null;
  requested_at: string;
  payable_at: string;
  paid_at: string | null;
  register_tx: string | null;
  pay_tx: string | null;
  cancel_tx: string | null;
  /** When an owner or admin released a closure that was held because its key was disabled. */
  released_at: string | null;
  [k: string]: unknown;
};

/** True for an open closure that is not being paid because its key was disabled: an owner or admin releases it. */
export const isClosureHeld = (c: { status: string; reason?: string | null; released_at?: string | null }): boolean =>
  (c.status === "queued" || c.status === "registered") && c.reason === "key_disabled" && !c.released_at;

/**
 * The answer of POST /api/v1/credits/close/cancel: a cancel_close transaction already signed by the key. The payer
 * adds its signature with {@link signCreditClosureCancel} and sends it; once it lands the key is open again.
 */
export type CreditClosureCancel = {
  transaction: string;
  message: string;
  accounts: Record<string, string>;
  payer: string;
  expires_at_block_height: number;
  signed_by_key: boolean;
  note?: string;
  [k: string]: unknown;
};

/** One closure let go by POST /api/v1/credits/close/release. */
export type CreditClosureRelease = { id: string; status: string; released: boolean; payable_at: string };

/**
 * The answer of POST /api/v1/credits/refund-destination-tx: an UNSIGNED set_refund_destination transaction. Only the
 * depositor's own wallet signs it ({@link signRefundDestination}); the API key is not in it.
 */
export type RefundDestinationTransaction = {
  transaction: string;
  message: string;
  /** `share` (this depositor's record for the key) and `refundToToken` (the USDC token account refunds will go to). */
  accounts: Record<string, string>;
  depositor: string;
  /** The wallet whose USDC token account receives this depositor's refunds from now on. */
  refund_to: string;
  /** The token account they go to today. */
  current_refund_to: string;
  expires_at_block_height: number;
  note?: string;
  [k: string]: unknown;
};

/** What DELETE /api/v1/keys/{hash} adds to its `data` when the disabled key had an open closure: it is now on hold. */
export type ClosureHeld = { id: string; reason: "key_disabled"; release: string };

const REFUNDS_RETURN = "A closure names no destination: what is left returns to the wallets that funded the key, and the API key cannot redirect it.";
/** `{ payer }` and nothing that names a destination: an older call (a destination string, refundTo, a second argument) fails here. */
function payerOnly(method: string, o: unknown, extra: unknown[]): { payer: string; signal?: AbortSignal } {
  const named = !!o && typeof o === "object" && ("refund_to" in o || "refundTo" in o);
  if (typeof o === "string" || named || extra.length)
    throw new TrellisError(`${method} takes only { payer }, the wallet that pays the transaction fee. ${REFUNDS_RETURN} A depositor moves its own refund destination with its wallet (refundDestinationTx).`, REFUND_DESTINATION_FIXED);
  const payer = (o as { payer?: unknown } | null | undefined)?.payer;
  if (typeof payer !== "string" || !payer) throw new TrellisError(`${method} needs { payer }: the wallet that pays the transaction fee. ${REFUNDS_RETURN}`, "bad_options");
  return o as { payer: string; signal?: AbortSignal };
}
/** The signer forms (`closeCreditsWith(payerSigner)`): a destination string where the signal used to follow is an older call. */
function noDestination(method: string, extra: unknown[]): void {
  if (extra.some((x) => x !== undefined && !(typeof x === "object" && x !== null && "aborted" in x)))
    throw new TrellisError(`${method} takes the payer's signer and nothing else. ${REFUNDS_RETURN}`, REFUND_DESTINATION_FIXED);
}

export type AttestedOptions = {
  providerId: string;
  /** The provider's /attest URL (or base URL). Required: the router's word alone is not enough to send. */
  attestUrl: string;
  expected?: ExpectedDigests;
  freshNonce?: boolean;
  allowSimulated?: boolean;
  requireCertificate?: boolean;
  maxAttestationAgeMs?: number;
  certificate?: Uint8Array | string;
  quoteVerifier?: QuoteVerifier;
  /** How long a passing verification is reused before the provider is checked again. Default 60 000 ms; 0 disables caching. */
  cacheMs?: number;
  /** Read the connection's certificate too (see `nodeAttestFetcher` in @trellis/client/node). */
  attestFetcher?: AttestFetcher;
};

export type RequestOptions = {
  disclosure?: DisclosureMax;
  lane?: Lane;
  /** Verify the provider first, then pin the request to it (`provider.only`, no fallbacks, lane "attested"). */
  attested?: AttestedOptions;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  verifyReceipt?: boolean;
};

/** What the client adds to a response. */
export type TrellisMeta = {
  generationId: string | null;
  /** The class the request was served under, from X-Trellis-Disclosure: attested, policy or vendor-forwarded. */
  disclosure: string | null;
  lane: string | null;
  receipt: ReceiptEnvelope | null;
  /** null when receipts are not verified or the response carried none. */
  receiptVerification: ReceiptVerification | null;
  /** The provider check that ran before this request was sent, when `attested` was used. */
  provider: ProviderVerification | null;
  /** Set when the receipt names a provider other than the verified one. */
  servedByVerifiedProvider: boolean | null;
  /** The settlement of a per-call payment (X-PAYMENT-RESPONSE), when this call was paid with one. */
  payment: PaymentResponse | null;
};

export type ChatBody = { model: string; messages: unknown[]; stream?: boolean; provider?: Record<string, unknown>; [k: string]: unknown };
export type ChatCompletion = { id?: string; model?: string; choices?: unknown[]; usage?: Record<string, unknown>; receipt?: ReceiptEnvelope; [k: string]: unknown };
export type ChatResult = ChatCompletion & { trellis: TrellisMeta };

export class Trellis {
  e2eeChat(body: E2eeChatBody, options: Omit<E2eeOptions, "baseUrl" | "headers" | "fetch">) { return e2eeChat(body, { ...options, baseUrl: this.baseUrl, headers: this.authHeaders(), fetch: this.f }); }
  readonly agent: ReturnType<typeof agentClient>;
  /** Playbooks: one rulebook many keys follow (management or team owner/admin keys). */
  readonly playbooks: ReturnType<typeof playbookClient>;
  /** $TRLS holder tiers: the tier table, this key's tier, advisory polls and a wallet-signed vote. Access and priority only. */
  readonly holders: ReturnType<typeof holderClient>;
  readonly agreements: ReturnType<typeof agreementClient>;
  readonly baseUrl: string;
  private readonly f: Fetch;
  /** `f`, answering a 402 with a per-call payment when `payer` is set. */
  private readonly paying: Fetch;
  private keys: KeySet | null;
  private keyFetch: Promise<KeySet> | null = null;
  private verified = new Map<string, { at: number; v: ProviderVerification }>();
  /** Set when `transparency` was given: the split-view checker for this router's log. */
  readonly transparency: TransparencyLog | null;

  constructor(private readonly opts: ClientOptions) {
    if (!opts?.baseUrl) throw new TrellisError("baseUrl is required", "bad_options");
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.f = opts.fetch ?? ((...a: Parameters<Fetch>) => fetch(...a));
    this.paying = opts.payer ? payPerCall(this.f, opts.payer.signer, opts.payer) : this.f;
    this.agreements = agreementClient(this.baseUrl, this.f, () => ({ ...this.opts.headers, ...this.authHeaders() }));
    this.agent = agentClient(this.baseUrl, this.f, () => ({ ...this.opts.headers, ...this.authHeaders() }));
    this.playbooks = playbookClient(this.baseUrl, this.f, () => ({ ...this.opts.headers, ...this.authHeaders() }));
    this.holders = holderClient(this.baseUrl, this.f, () => ({ ...this.opts.headers, ...this.authHeaders() }));
    this.keys = opts.receiptKeys ?? null;
    this.transparency = opts.transparency ? new TransparencyLog({ logUrl: this.baseUrl, ...opts.transparency, fetch: this.f, ed25519: opts.ed25519 }) : null;
  }

  /** A copy that authenticates with a blind token (see buyTokens in @trellis/client/blind) instead of an API key. */
  withPrivateToken(token: string): Trellis {
    return new Trellis({ ...this.opts, apiKey: undefined, privateToken: token });
  }

  private authHeaders(): Record<string, string> {
    if (this.opts.privateToken) return { authorization: `PrivateToken token=${this.opts.privateToken}` };
    if (this.opts.apiKey) return { authorization: `Bearer ${this.opts.apiKey}` };
    return {};
  }

  // ---- receipts ---------------------------------------------------------------------------------------------------

  /** The router's published receipt keys, fetched once and reused. */
  async receiptKeys(refresh = false): Promise<KeySet> {
    if (this.keys && !refresh && !this.opts.receiptKeys) return this.keys;
    if (this.opts.receiptKeys) return this.opts.receiptKeys;
    this.keyFetch ??= fetchReceiptKeys(this.baseUrl, this.f).finally(() => (this.keyFetch = null));
    return (this.keys = await this.keyFetch);
  }

  /** Verify a receipt against the router's keys, re-reading the key set once when the key id is unknown (key rotation). */
  async verifyReceipt(receipt: ReceiptEnvelope): Promise<ReceiptVerification> {
    let keys = await this.receiptKeys();
    if (!keys.keys.some((k) => k.kid === receipt?.key_id) && !this.opts.receiptKeys) keys = await this.receiptKeys(true);
    const v = await verifyReceipt(receipt, { keys, ed25519: this.opts.ed25519 });
    if (!this.transparency) return v;
    // Opt-in: the key must also be in the witnessed log, with no split view.
    const jwk = keys.keys.find((k) => k.kid === receipt?.key_id);
    let logged: ReceiptVerification["checks"][number];
    try {
      if (!jwk) throw new Error("the receipt names no published key");
      const r = await this.transparency.requireLogged("receipt_key", base64ToBytes(jwk.x));
      logged = { id: "key_logged", status: "pass", detail: `key is entry ${r.index} of the transparency log, under a checkpoint of size ${r.checkpoint.size} cosigned by ${r.cosignedBy.join(", ")}` };
    } catch (e) {
      logged = { id: "key_logged", status: "fail", detail: (e as Error).message };
    }
    return { ...v, valid: v.valid && logged.status === "pass", checks: [...v.checks, logged] };
  }

  /** GET /api/v1/receipts/:id, including its anchor proof once the receipt has been anchored. */
  async getReceipt(id: string, signal?: AbortSignal): Promise<ReceiptEnvelope> {
    const res = await this.f(`${this.baseUrl}/api/v1/receipts/${encodeURIComponent(id)}`, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new TrellisError(`receipt lookup failed with ${res.status}`, "receipt_lookup_failed", res.status);
    return ((await res.json()) as { data: ReceiptEnvelope }).data;
  }

  // ---- attestation ------------------------------------------------------------------------------------------------

  /** What the router says it has verified about a provider. */
  attestation(providerId: string, signal?: AbortSignal): Promise<RouterAttestation | null> {
    return fetchRouterAttestation(this.baseUrl, providerId, this.f, signal);
  }

  /** Check a provider now (no caching). Never throws for a bad provider: read `.ok` and `.checks`. */
  verifyProvider(o: AttestedOptions & { signal?: AbortSignal }): Promise<ProviderVerification> {
    return verifyProvider({ routerUrl: this.baseUrl, fetch: this.f, now: this.opts.now, ...o });
  }

  private async attest(o: AttestedOptions, signal?: AbortSignal): Promise<ProviderVerification> {
    const ttl = o.cacheMs ?? 60_000;
    const key = `${o.providerId}|${o.attestUrl}`;
    const hit = this.verified.get(key);
    const clock = this.opts.now ?? Date.now;
    if (hit && ttl > 0 && clock() - hit.at < ttl) return hit.v;
    const v = await this.verifyProvider({ ...o, signal });
    if (v.ok) this.verified.set(key, { at: clock(), v });
    else this.verified.delete(key);
    if (!v.ok) throw new AttestationRefused(v);
    return v;
  }

  // ---- chat -------------------------------------------------------------------------------------------------------

  private async prepare(body: ChatBody, o: RequestOptions) {
    const disclosure = o.disclosure ?? this.opts.disclosure;
    const lane = o.lane ?? this.opts.lane;
    let provider: ProviderVerification | null = null;
    let routed = withRouting(body, { disclosure, lane });
    let headers: Record<string, string> = { ...routingHeaders({ disclosure, lane }) };
    if (o.attested) {
      // Nothing has been sent yet. A provider that does not verify ends the call here.
      provider = await this.attest(o.attested, o.signal);
      routed = withRouting(routed, { disclosure: "none", lane: "attested", only: [o.attested.providerId], allowFallbacks: false });
      headers = { ...headers, ...routingHeaders({ disclosure: "none", lane: "attested" }) };
    }
    return { routed, headers, provider };
  }

  private async finish(res: Response, receipt: ReceiptEnvelope | null, provider: ProviderVerification | null, o: RequestOptions): Promise<TrellisMeta> {
    let receiptVerification: ReceiptVerification | null = null;
    if (receipt && (o.verifyReceipt ?? this.opts.verifyReceipts ?? true)) {
      receiptVerification = await this.verifyReceipt(receipt);
      if (!receiptVerification.valid && this.opts.strictReceipts) throw new ReceiptInvalid(receiptVerification);
    }
    return {
      generationId: res.headers.get("x-generation-id"),
      disclosure: res.headers.get("x-trellis-disclosure"),
      lane: res.headers.get("x-trellis-lane"),
      receipt,
      receiptVerification,
      provider,
      servedByVerifiedProvider: provider && receipt ? receipt.payload?.provider === provider.providerId : null,
      payment: parsePaymentResponse(res.headers),
    };
  }

  private async post(path: string, body: unknown, headers: Record<string, string>, o: RequestOptions): Promise<Response> {
    const text = JSON.stringify(body);
    const url = `${this.baseUrl}${path}`;
    // The chat routes bind the request hash (the body without stream and stream_options, as canonical JSON); the wallet
    // signs it with the method, the router's host and the path, so the header is good for this call and no other.
    const wallet: Record<string, string> =
      this.opts.walletAuth && !this.opts.apiKey && !this.opts.privateToken
        ? { "x-wallet-auth": await walletAuthHeader(this.opts.walletAuth, { method: "POST", url, ...(this.opts.walletAuthHost ? { host: this.opts.walletAuthHost } : {}), ...(/\/completions$/.test(path) ? { chat: JSON.parse(text) as Record<string, unknown> } : { json: JSON.parse(text) as unknown }) }) }
        : {};
    return this.paying(url, {
      method: "POST",
      signal: o.signal,
      headers: { "content-type": "application/json", ...this.opts.headers, ...this.authHeaders(), ...wallet, ...headers, ...o.headers },
      body: text,
    });
  }

  // ---- credits (USDC on Solana) -------------------------------------------------------------------------------------

  /** A JSON call to the router's API with the key; a failed answer throws {@link TrellisError} with the router's reason. */
  private async api<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.opts.headers, ...this.authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw new TrellisError(json?.error?.message ?? `${method} ${path} failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data as T;
  }

  /**
   * POST /api/v1/credits/deposit-tx: an unsigned trellis_credits::deposit transaction moving `amount` USDC (decimal
   * string, up to 6 places) from `payer`'s wallet into this key's credits. The wallet signs and sends it; the key is
   * credited once it is finalized. Credits are spend-only. `refund_to` in the answer is where what is left of this
   * deposit returns if the key's credits are ever closed: the token account it is paid from.
   */
  depositTx(amount: string, payer: string, signal?: AbortSignal): Promise<DepositTransaction> {
    return this.api("POST", "/api/v1/credits/deposit-tx", { amount, payer }, signal);
  }

  /**
   * POST /api/v1/credits/close: close this key's credits. What is left is paid back to the wallets that deposited to
   * the key (the answer's `refunds`), after the dispute window, never on demand. There is no destination to pass: the
   * API key cannot choose or change where the refund goes, and a call that names one throws. `payer` is any wallet;
   * it only pays the fee. Must be called with the key itself. The returned `transaction` already carries the key's
   * signature: sign it with `signCreditClosure(closure.transaction, payerSigner)` and send it, or use
   * {@link closeCreditsWith}. From the moment it lands the key answers 409 `credits_closing` to anything that would
   * spend; until anything is paid it can be taken back with {@link cancelCreditClosure}.
   */
  closeCredits(o: { payer: string; signal?: AbortSignal }, ...legacy: never[]): Promise<CreditClosure> {
    const { payer, signal } = payerOnly("closeCredits", o, legacy);
    return this.api("POST", "/api/v1/credits/close", { payer }, signal);
  }

  /**
   * Request the closure with `payer` as fee payer and add the payer's signature. Returns the closure and, unless it was
   * already registered on chain, `signed`: the transaction (base64) ready to send to the cluster (`sendTransaction`).
   */
  async closeCreditsWith(payer: Signer, signal?: AbortSignal, ...legacy: never[]): Promise<{ closure: CreditClosure; signed: string | null }> {
    noDestination("closeCreditsWith", [signal, ...legacy]);
    const closure = await this.closeCredits({ payer: walletAddress(payer.publicKey), signal });
    return { closure, signed: closure.transaction ? await signCreditClosure(closure.transaction, payer) : null };
  }

  /**
   * POST /api/v1/credits/close/cancel: take a closure back while nothing has been paid. Called with the key itself;
   * the returned cancel_close transaction already carries the key's signature and `payer` (any wallet) pays the fee:
   * `signCreditClosureCancel(cancel.transaction, payerSigner)`, then send it. Once it lands the key is open again with
   * its balance. 400 `nothing_to_cancel` when no closure is on chain, 409 `refund_in_progress` once a payment was sent.
   * Who may cancel: whoever asked for the closure, or the key's registered owner wallet. The key itself only for a
   * closure the key asked for, and once in 60 days: 409 `cancel_cooldown` after that (error.metadata.retry_at), 403
   * `not_requester` for a closure the owner wallet asked for. A wallet that only deposited to the key cannot cancel.
   */
  cancelCreditClosure(o: { payer: string; signal?: AbortSignal }, ...legacy: never[]): Promise<CreditClosureCancel> {
    const { payer, signal } = payerOnly("cancelCreditClosure", o, legacy);
    return this.api("POST", "/api/v1/credits/close/cancel", { payer }, signal);
  }

  /** Request the cancellation with `payer` as fee payer and add the payer's signature: `signed` is the transaction to send. */
  async cancelCreditClosureWith(payer: Signer, signal?: AbortSignal, ...legacy: never[]): Promise<{ cancel: CreditClosureCancel; signed: string }> {
    noDestination("cancelCreditClosureWith", [signal, ...legacy]);
    const cancel = await this.cancelCreditClosure({ payer: walletAddress(payer.publicKey), signal });
    return { cancel, signed: await signCreditClosureCancel(cancel.transaction, payer) };
  }

  /**
   * POST /api/v1/credits/close/release: let a held closure go ahead. A closure is not paid while its key is disabled
   * (disabling a key stops a closure it started); an owner or admin of the account releases it on purpose, with their
   * own key. `keyHash` is the hash that names the closed key (as GET /api/v1/keys lists it), never the key itself.
   * The refund still only returns to the wallets that paid in.
   */
  releaseCreditClosure(keyHash: string, signal?: AbortSignal): Promise<CreditClosureRelease[]> {
    if (!/^[0-9a-f]{64}$/.test(keyHash)) throw new TrellisError("releaseCreditClosure takes the key's hash (64 hex characters, as GET /api/v1/keys lists it), not the API key", "bad_options");
    return this.api("POST", "/api/v1/credits/close/release", { key: keyHash }, signal);
  }

  /**
   * POST /api/v1/credits/refund-destination-tx: an UNSIGNED transaction that moves where `depositor`'s own deposits to
   * this key are refunded, to `refundTo`'s USDC token account. Only the depositor's wallet can sign it
   * (`signRefundDestination`, or {@link setRefundDestinationWith}); the API key cannot. It moves no money now.
   * 404 when that wallet never deposited to the key.
   */
  refundDestinationTx(o: { depositor: string; refundTo: string; signal?: AbortSignal }): Promise<RefundDestinationTransaction> {
    return this.api("POST", "/api/v1/credits/refund-destination-tx", { depositor: o.depositor, refund_to: o.refundTo }, o.signal);
  }

  /** Ask for the change with `depositor`'s address and sign it with that wallet: `signed` is the transaction to send. */
  async setRefundDestinationWith(depositor: Signer, refundTo: string, signal?: AbortSignal): Promise<{ request: RefundDestinationTransaction; signed: string }> {
    const request = await this.refundDestinationTx({ depositor: walletAddress(depositor.publicKey), refundTo, signal });
    return { request, signed: await signRefundDestination(request.transaction, depositor) };
  }

  /** GET /api/v1/credits/close: this key's closures, newest first, with who is paid back and whether one is on hold ({@link isClosureHeld}). */
  creditClosures(signal?: AbortSignal): Promise<CreditClosureRecord[]> {
    return this.api("GET", "/api/v1/credits/close", undefined, signal);
  }

  readonly chat = {
    completions: {
      /** POST /api/v1/chat/completions (non-streaming). */
      create: async (body: ChatBody, o: RequestOptions = {}): Promise<ChatResult> => {
        if (body.stream) throw new TrellisError("Use chat.completions.stream() for streaming requests.", "bad_options");
        const { routed, headers, provider } = await this.prepare(body, o);
        const res = await this.post("/api/v1/chat/completions", routed, headers, o);
        const json = (await res.json().catch(() => null)) as (ChatCompletion & { error?: { message?: string; type?: string; metadata?: unknown } }) | null;
        if (!res.ok || !json) throw requestError(json?.error?.message ?? `chat request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
        const meta = await this.finish(res, json.receipt ?? null, provider, o);
        return { ...json, trellis: meta };
      },
      /**
       * POST with stream: true. Iterate for the parsed chunks; `meta()` resolves after the stream ends with the
       * receipt (sent as the last event) and its verification.
       */
      stream: async (body: ChatBody, o: RequestOptions = {}): Promise<ChatStream> => {
        const { routed, headers, provider } = await this.prepare({ ...body, stream: true }, o);
        const res = await this.post("/api/v1/chat/completions", routed, headers, o);
        if (!res.ok || !res.body) {
          const json = (await res.json().catch(() => null)) as { error?: { message?: string; type?: string; metadata?: unknown } } | null;
          throw requestError(json?.error?.message ?? `chat request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
        }
        return new ChatStream(res, (receipt) => this.finish(res, receipt, provider, o));
      },
    },
  };

  async models(signal?: AbortSignal): Promise<{ data: Array<Record<string, unknown>> }> {
    const res = await this.f(`${this.baseUrl}/api/v1/models`, { signal, headers: { ...this.authHeaders(), accept: "application/json" } });
    if (!res.ok) throw new TrellisError(`models request failed with ${res.status}`, "request_failed", res.status);
    return (await res.json()) as { data: Array<Record<string, unknown>> };
  }
}

/** Server-sent events from a streamed completion. */
export class ChatStream implements AsyncIterable<Record<string, unknown>> {
  private receipt: ReceiptEnvelope | null = null;
  /** Every event before the receipt, with the chain value the router sent after it (receipt v2). */
  readonly chained: ChainedEvent[] = [];

  /**
   * After iterating: recompute the chunk hash chain over the events received and compare it with each value the
   * router sent and with the head signed in the v2 receipt. A cut or altered stream fails here.
   */
  async verifyChain(): Promise<{ ok: boolean; head: string; signedHead: string | null; firstMismatch: number | null }> {
    const v2 = (this.receipt as { v2?: { claims?: { rid?: string; resp?: { chain?: string } } } } | null)?.v2;
    const rid = v2?.claims?.rid ?? String(this.receipt?.id ?? "");
    const r = await checkChain(rid, this.chained);
    const signedHead = v2?.claims?.resp?.chain ?? null;
    return { ok: r.ok && signedHead === r.head, head: r.head, signedHead, firstMismatch: r.firstMismatch };
  }
  private resolveMeta!: (m: TrellisMeta) => void;
  private rejectMeta!: (e: unknown) => void;
  private readonly metaPromise: Promise<TrellisMeta>;

  constructor(
    private readonly res: Response,
    private readonly finish: (receipt: ReceiptEnvelope | null) => Promise<TrellisMeta>,
  ) {
    this.metaPromise = new Promise((resolve, reject) => {
      this.resolveMeta = resolve;
      this.rejectMeta = reject;
    });
    this.metaPromise.catch(() => {}); // a caller that only iterates should not get an unhandled rejection
  }

  meta(): Promise<TrellisMeta> {
    return this.metaPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>> {
    const reader = this.res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const cut = buf.search(/\r?\n\r?\n/);
          if (cut < 0) break;
          const block = buf.slice(0, cut);
          buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
          const link = /^: trellis-chain (\d+) ([0-9a-f]{64})$/m.exec(block);
          if (link && Number(link[1]) === this.chained.length && this.chained.length) this.chained[this.chained.length - 1].chain = link[2];
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.receipt && typeof chunk.receipt === "object") this.receipt = chunk.receipt as ReceiptEnvelope;
          else this.chained.push({ data });
          yield chunk;
        }
      }
      this.resolveMeta(await this.finish(this.receipt));
    } catch (e) {
      this.rejectMeta(e);
      throw e;
    } finally {
      reader.releaseLock();
    }
  }
}
