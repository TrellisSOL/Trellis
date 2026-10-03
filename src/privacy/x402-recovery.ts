import type { ExternalDoc, RedisFamily, TableDoc } from "./types.ts";
import { CREATED, rv } from "./tables/common.ts";

// x402 payment recovery (src/solana/recovery.ts): what a paid x402 call leaves so a lost answer can be sent again, for 24 hours.

const ev = (file: string, contains: string) => ({ file, contains });

export const x402RecoveryTables: Record<string, TableDoc> = {
  x402_paid_results: {
    category: "billing",
    purpose: "One row per x402 payment whose call was answered, so a payer who lost the answer can have it sent again instead of paying twice. It names the paying wallet and the authorization nonce and holds hashes; the answer itself is sealed outside the database.",
    request: "yes",
    retention: "24 hours. Recovery refuses an older row, and the x402-recovery-expire job deletes it together with any sealed answer still held for it.",
    columns: {
      payer: "The wallet that signed the payment (base58), as on the public settlement.",
      nonce: "The payment's nonce (its transaction signature), public on-chain once settled.",
      request_sha256: {
        purpose: "SHA-256 of the request the payment paid for (the receipt's request_sha256). A recovery must send the identical request.",
        review: rv(["name:content"], "digest-only", "A hash of the request body, compared with the hash of a recovery request so an answer is sent again only for the request it answered."),
      },
      response_sha256: {
        purpose: "SHA-256 of the answer's bytes as they were sent, checked before the sealed answer is sent again.",
        review: rv(["name:content"], "digest-only", "A hash of the answer bytes, so the answer sent again is checked to be byte-identical to the one first sent; the answer cannot be recovered from it."),
      },
      body_ref: {
        purpose: "The name of the Redis key that holds the sealed answer: x402paid: and a SHA-256 of the payer and the nonce.",
        review: rv(["name:content"], "no-request-content", "A fixed prefix and a hash of the payer and the nonce naming where the sealed answer lives; the answer bytes are never written to this column."),
      },
      created_at: CREATED,
    },
  },
};

export const x402RecoveryFamily: RedisFamily = {
  key: "x402paid:<sha256>",
  purpose:
    "x402 payment recovery. The answer to a call paid with x402, kept so the payer can have it sent again, byte for byte, if it was lost on the way (PAYMENT-RECOVERY), instead of paying twice. It is sealed with AES-256-GCM under a key derived from the router's APP_SECRET, the payer, the authorization nonce and the request's hash, so only a recovery of that exact request by that payer can open it. The key is a SHA-256 of the payer and the nonce.",
  holds: "digest",
  requestText: "answer-text",
  ttl: "86,400 seconds (24 hours) from the answer, set when it is written; the x402-recovery-expire job also deletes it with its row. Calls not paid with x402 leave nothing here.",
  evidence: [
    ev("src/solana/recovery.ts", "export const RECOVERY_TTL_MS = 24 * 3_600_000;"),
    ev("src/solana/recovery.ts", "await ctx.db.delete(x402PaidResults).where(lt(x402PaidResults.createdAt, new Date(Date.now() - RECOVERY_TTL_MS)))"),
    ev("src/solana/recovery.ts", "store = { set: async (k, v, ttl) => { await redis.set(k, v, \"PX\", ttl); }"),
    ev("src/solana/recovery.ts", "const bodyRefOf = (payer: string, nonce: string) => `x402paid:${sha256(`${payer}:${nonce}`)}`;"),
    ev("src/solana/recovery.ts", "encrypt(sealKey(ctx, r.payer, r.nonce, r.requestSha256), JSON.stringify(sealed)), RECOVERY_TTL_MS)"),
  ],
};

export const x402RecoveryReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/solana/recovery.ts",
  carries: "prompt-or-answer",
  reads: "The body of a paid x402 call on the chat, completions, embeddings, rerank and character chat routes, and of a recovery request; and the answer's bytes once the call is answered.",
  then: "Hashes the request (the receipt's request_sha256) to bind the answer to it, or to compare a recovery request with it. Seals the answer's bytes with AES-256-GCM. A recovery checks the payer's ed25519 signature first and never submits the payment again.",
  kept: "The two SHA-256 hashes, the payer, the nonce and the Redis key name in x402_paid_results, and the sealed answer in Redis (or the router's memory without Redis), each for 24 hours. The request text is not kept. No log field, no caller-address reader.",
  evidence: [ev("src/solana/recovery.ts", "export function paymentRecovery(app: Hono, ctx: Ctx)"), ev("src/solana/recovery.ts", "if (!verifyRecoverySignature(ctx.cfg.chain.network, claim)) return { ok: false, status: 401, reason: \"bad_signature\" };")],
};
