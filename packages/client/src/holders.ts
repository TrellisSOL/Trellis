import type { Fetch } from "./types.js";
import { canonicalJson } from "./canonical.js";
import { requestError } from "./agent-errors.js";
import { walletAuthHeader, type Signer } from "./solana.js";

// $TRLS holder tiers: membership levels with fixed thresholds. Their perks are access and priority (higher limits,
// sealed-lane and Bushel purchase priority, early access to newly listed models, an advisory vote, credits that do not
// expire while the tier is held, an opt-in profile badge). No tier changes a price: every caller pays the host's price.
// These helpers read what the router returns today, which can change.

/** One membership level. No field is an amount of money. `min` is the threshold in whole tokens (a decimal string). */
export type HolderTier = {
  name: string; min: string; rpm_multiplier: number; tpm_multiplier: number;
  max_agent_keys: number | null; max_saved_routes: number | null; max_batch_rows: number | null;
  sealed_priority: number; early_access_hours: number; vote_weight: number; credits_never_expire: boolean; badge: boolean;
};
/** GET /api/v1/holders/tiers. When `enabled` is false, holder tiers are not switched on yet and `tiers` is empty. */
export type HolderTiers = { enabled: boolean; token: { address: string; symbol: string; program: string } | null; cache_s: number; tiers: HolderTier[] };
/** The limits a key runs under now (0: no cap; a null `tpm`: not set on the key). */
export type HolderLimits = { rpm: number; tpm: number | null; agent_keys: number; saved_routes: number; presets: number; batch_rows: number };
export type HolderPerks = { limits: HolderLimits; sealed_priority: number; early_access_hours: number; vote_weight: number; credits_never_expire: boolean; badge: boolean };
/** GET /api/v1/holders/me: the tier of the wallet behind the key. A key with no wallet gets `wallet: null` and a `hint`. */
export type HolderStatus = {
  enabled: boolean; token: { address: string; symbol: string } | null; wallet: string | null; balance: string | null; balance_error: boolean;
  tier: HolderTier | null; next_tier: { name: string; min: string; remaining: string } | null; perks: HolderPerks; hint?: string;
};
export type HolderPollKind = "model_listing" | "slash_schedule";
/** An advisory poll with its public tally. A result informs a decision and never carries it out. */
export type HolderPoll = {
  id: string; kind: HolderPollKind; title: string; options: string[]; status: "open" | "closed";
  created_at: string; closes_at: string | null; closed_at: string | null; advisory: true;
  results: { options: { option: string; votes: number; weight: number }[]; total_votes: number; total_weight: number; final: boolean };
};
/** A recorded vote: the tier the wallet voted with and that tier's fixed weight. */
export type HolderVote = { poll_id: string; option: string; tier: string; weight: number; voted_at: string };
/** `early_access` on a model in GET /api/v1/models: null unless the model's early-access window is running. */
export type ModelEarlyAccess = { until: string; your_access_at: string } | null;
/** `metadata` of the 403 `early_access` a call to a model not open to the caller yet gets. Nothing is charged for it. */
export type EarlyAccessRefusal = { model: string; opens_at: string; early_access_until: string; tier: string | null };

/** The vote body. It names the poll as well as the option, so the signature cannot be used on another poll. */
export const holderVoteBody = (pollId: string, option: string) => ({ poll_id: pollId, option });

/** The path of the vote route for a poll: part of what the wallet signs. */
export const holderVotePath = (pollId: string) => `/api/v1/holders/polls/${encodeURIComponent(pollId)}/vote`;

/**
 * The `X-Wallet-Auth` header for a vote at the router whose public host is `host`: the wallet signs the method (POST),
 * that host, the vote path, the time and the SHA-256 of the canonical JSON of the body (keys sorted, no spaces), which
 * is what the router hashes.
 */
export const holderVoteHeader = (signer: Signer, host: string, pollId: string, option: string, now?: number): Promise<string> =>
  walletAuthHeader(signer, { method: "POST", host, path: holderVotePath(pollId), json: holderVoteBody(pollId, option), now });

/** Holder tier helpers. `tiers`, `polls` and `poll` are public; `me` needs the key; `vote` is signed by the wallet. */
export function holderClient(baseUrl: string, fetcher: Fetch, headers: () => Record<string, string>) {
  async function request<T>(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
    const res = await fetcher(`${baseUrl}/api/v1/holders${path}`, { method: init.method ?? "GET", signal: init.signal, headers: { accept: "application/json", ...(init.headers ?? headers()) }, ...(init.body === undefined ? {} : { body: init.body }) });
    const json = await res.json().catch(() => null) as { data: T; error?: { message?: string; type?: string; metadata?: unknown } } | null;
    if (!res.ok || !json) throw requestError(json?.error?.message ?? `holder request failed with ${res.status}`, json?.error?.type ?? "request_failed", res.status, json?.error?.metadata);
    return json.data;
  }
  const one = (id: string) => `/polls/${encodeURIComponent(id)}`;
  return {
    /** GET /api/v1/holders/tiers: the tier table. `enabled: false` means holder tiers are not switched on yet. */
    tiers: (signal?: AbortSignal) => request<HolderTiers>("/tiers", { signal }),
    /** GET /api/v1/holders/me: the tier of the wallet behind this key, the next threshold and the perks that apply now. */
    me: (signal?: AbortSignal) => request<HolderStatus>("/me", { signal }),
    /** GET /api/v1/holders/polls: advisory polls, newest first; `status` keeps only open or only closed ones. */
    polls: (query: { status?: "open" | "closed" } = {}, signal?: AbortSignal) => request<HolderPoll[]>(`/polls${query.status ? `?status=${query.status}` : ""}`, { signal }),
    /** GET /api/v1/holders/polls/:id: one poll and its tally. */
    poll: (id: string, signal?: AbortSignal) => request<HolderPoll>(one(id), { signal }),
    /**
     * POST /api/v1/holders/polls/:id/vote: one vote per wallet, signed by `signer` (the wallet that holds the tier). The
     * API key is not sent: the wallet's signature is what the router checks. Refusals keep the router's code:
     * not_a_holder (403), already_voted and poll_closed (409). A vote cannot be changed.
     */
    vote: async (pollId: string, option: string, signer: Signer, signal?: AbortSignal) => {
      const body = canonicalJson(holderVoteBody(pollId, option));
      const { authorization: _key, Authorization: _Key, ...rest } = headers();
      return request<HolderVote>(`${one(pollId)}/vote`, { method: "POST", body, signal, headers: { ...rest, "content-type": "application/json", "x-wallet-auth": await holderVoteHeader(signer, new URL(baseUrl).host, pollId, option) } });
    },
  };
}
