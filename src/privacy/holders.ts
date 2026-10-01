import type { Evidence, ExternalDoc, RedisFamily, TableDoc } from "./types.ts";
import { JSON_FIELDS, KEPT, UPDATED, rv } from "./tables/common.ts";

// $TRLS holder perks (src/holders/, src/solana/tiers.ts): the early-access window of a model, advisory polls and their
// votes, the vote rate limit and the routes that read a body. A wallet's token balance is read from the chain and
// cached in memory for an hour; it is never written to the database.

const ev = (file: string, contains: string): Evidence => ({ file, contains });

export const holderTables: Record<string, TableDoc> = {
  model_early_access: {
    category: "providers",
    request: "no",
    purpose: "The early-access window of a model: until it ends, callers may use the model from a time set by their holder tier, and callers with no tier when it ends. Written when a model is first listed while a tier has early_access_hours, or by an operator.",
    retention: "Kept until an operator clears the window (DELETE /api/v1/admin/models/:author/:slug/early-access). A window that has ended gates nothing and is no longer loaded.",
    columns: {
      model_id: "The model the window belongs to.",
      listed_at: "When the model was listed, or when the operator set the window.",
      until: "When the window ends and the model opens to every caller.",
      source: "Who set the window: listing (the registry, at first listing) or operator.",
      updated_at: UPDATED,
    },
  },
  holder_polls: {
    category: "operations",
    request: "no",
    purpose: "Advisory polls an operator opens for holders: which model to list next, or which slash schedule to adopt. A result is advice; nothing is carried out from it.",
    retention: KEPT,
    columns: {
      id: "Poll id.",
      kind: "model_listing or slash_schedule.",
      title: { purpose: "The question, written by the operator, up to 200 characters.", review: rv(["name:content"], "config", "Text an operator writes when opening a poll through the admin route, limited to 200 characters without control characters. It is public and is not taken from any request for inference.") },
      options: "The options on offer, written by the operator: candidate model ids for model_listing, schedule names for slash_schedule.",
      status: "open or closed.",
      closes_at: "When voting stops, if the operator set a time or began closing the poll.",
      created_at: "When the poll was opened.",
      closed_at: "When the operator closed it.",
      results: { purpose: "The final tally written at close: per option, the number of votes and their summed fixed weights, and the totals.", review: JSON_FIELDS("Option names copied from the poll and integer counts computed by the router. It holds no wallet address and no text from any caller.") },
    },
  },
  holder_votes: {
    category: "operations",
    request: "no",
    purpose: "One vote per poll per wallet. A wallet proves itself with a signature (X-Wallet-Auth) and must hold a tier; the weight is that tier's fixed vote weight, never the size of the balance.",
    retention: "Kept with the poll. No job or route removes votes; a vote that arrives after voting stopped is deleted when the poll closes.",
    notes: ["Public results show the tally only, never which wallet voted for what. The router does store the wallet address next to its choice, and wallet addresses are public on chain, so the operator can tell how a wallet voted. The token balance itself is not stored: only the name of the tier it reached."],
    columns: {
      poll_id: "The poll.",
      wallet: "The voting wallet's public address.",
      choice: "The option chosen, one of the poll's options.",
      tier: "The name of the tier the wallet held when it voted.",
      weight: "That tier's fixed vote weight when the vote was cast.",
      closing_tier: "The name of the tier the wallet held when the poll closed, or empty when it held none or the poll is open.",
      closing_weight: "The weight counted in the final tally: lowered when the wallet had dropped below the tier it voted with. Empty while the poll is open.",
      voted_at: "When the vote was cast.",
    },
  },
};

export const holderVoteLimit: RedisFamily = {
  key: "rl:holder-vote:<wallet address>:<window start>",
  purpose: "Votes in holder polls, ten per minute per wallet. Contains only the wallet's public address and a counter.",
  holds: "wallet",
  limiterPrefix: "holder-vote:",
  windowSeconds: 60,
  ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [ev("src/api/holders.ts", "await ctx.limiter.take(`holder-vote:${auth.wallet}`"), ev("src/lib/ratelimit.ts", "const k = `rl:${key}:${start}`;"), ev("src/lib/ratelimit.ts", "await this.redis.pexpire(k, windowMs + 1000);")],
};

export const holderBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/holders.ts",
  carries: "settings",
  reads: "A vote (the poll id and one of its options, signed by the voting wallet); from an operator, a new poll (kind, title, options, optional closing time) or the end time of a model's early-access window.",
  then: "A vote is checked against the wallet's signature, the poll's options and the wallet's holder tier, read from its token account on chain. Operator bodies are checked against strict schemas after the operator token.",
  kept: "The vote in holder_votes (wallet address, option, tier name and fixed weight); the poll in holder_polls; the window in model_early_access. No prompt or answer passes through these routes.",
  evidence: [ev("src/api/holders.ts", "const v = voteSchema.parse(body);"), ev("src/api/holders.ts", "pollCreateSchema.parse(await readJson(c))")],
};

/** The router's small key-value state for holder perks (kv notes). */
export const holderKvNotes = [
  "credits-expiry-cursor: the key hash the credits expiry step stopped at, so its next run continues from there. Written only with CREDITS_EXPIRY_ENABLED; holds no balance and no wallet.",
  "credits-expiry-notice:<chain id>:<chain key hash>:<notice time>: one marker per on-chain expiry notice, written only with CREDITS_EXPIRY_ENABLED: the account id, the key hash, the notice time, when the marker was recorded, the earliest sweep time (a full grace period, 30 days at least, after the later of the two), the noticed USD amount and the notice transaction signature. The account's inbox shows it under account-wide access for 90 days as a fixed title with the date and amount; the response carries a digest of the marker key, not the key hash. Kept until operator deletion so a balance is never swept before its notice has stood for the grace period. No wallet address, prompt or answer.",
  "credits-expiry-sweep:<chain id>:<chain key hash>: a sweep in flight, written before sweep_expired is sent and deleted in the transaction that records the ledger debit: the account id, key hash, the on-chain balance and deposited total at that moment, the notice time, the send time and, once confirmed, the transaction signature. It lets a later run debit the ledger only for a sweep the chain confirmed. No wallet address.",
];
