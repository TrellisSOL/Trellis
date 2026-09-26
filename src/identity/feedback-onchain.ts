import { PublicKey } from "@solana/web3.js";
import type { Ctx } from "../context.ts";
import { documentHash, documentHashBytes, FEEDBACK_VALUE_DECIMALS } from "./agent-registry.ts";
import { identityChain } from "./chain.ts";
import { ownerWallets } from "./identity.ts";

/**
 * The optional on-chain half of a feedback entry about a registered identity (an agent key, a network host or a tool
 * listing): a give_feedback transaction for the reviewer's own wallet. The registry records the paid amount (value, 6
 * decimals), the score, the tags and the hash of the entry as served at `feedbackURI`, which names the receipt hash.
 * Only with that paid evidence: an entry whose receipt is not signed yet gets no transaction, and neither does a
 * reviewer without a linked wallet. Null when no registry is configured.
 */
export async function feedbackOnchain(ctx: Ctx, a: {
  reviewerKeyHash: string;
  /** The registered identity: its registry id and its asset (the agent id). */
  registry: string | null;
  agentId: string;
  /** The public entry document and the URL it is served at. */
  entry: unknown;
  feedbackURI: string;
  receiptHash: `0x${string}` | null;
  paidPico: bigint;
  score: number;
  tag1: string | null;
  tag2: string | null;
}): Promise<Record<string, unknown> | null> {
  const programId = ctx.cfg.identity.registry.programId;
  if (!programId) return null;
  const base = { program_id: programId, registry: a.registry, agent_id: a.agentId };
  if (!a.receiptHash) return { ...base, feedback_uri: a.feedbackURI, transaction: null, note: "The receipt is not signed yet, so there is no receipt hash to record; the entry stays off chain." };
  const [client] = await ownerWallets(ctx, a.reviewerKeyHash);
  if (!client) return { ...base, feedback_uri: a.feedbackURI, feedback_hash: documentHash(a.entry), transaction: null, note: "Link a wallet to this account (wallet sign-in) to also record the entry in the agent registry." };
  const units = a.paidPico / 1_000_000n; // pico-USD to USDC base units
  try {
    const collection = await identityChain(ctx).collection();
    const prepared = await identityChain(ctx).feedbackTransaction({ client: new PublicKey(client), asset: new PublicKey(a.agentId), collection, paidUsdcUnits: units, score: a.score, tag1: a.tag1 ?? "", tag2: a.tag2 ?? "", feedbackURI: a.feedbackURI, feedbackHash: documentHashBytes(a.entry) });
    return { ...base, fee_payer: client, feedback_uri: a.feedbackURI, feedback_hash: documentHash(a.entry), receipt_hash: a.receiptHash, value_units: units.toString(), value_decimals: FEEDBACK_VALUE_DECIMALS, transaction: prepared.transaction, expires_at_block_height: prepared.expiresAtBlockHeight, instruction: prepared.instruction, note: "Optional: sign and send from your own wallet to also record this entry in the agent registry." };
  } catch {
    return { ...base, feedback_uri: a.feedbackURI, feedback_hash: documentHash(a.entry), transaction: null, note: "The agent registry could not be reached to prepare the transaction." };
  }
}
