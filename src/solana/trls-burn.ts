import { PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { escrowDeposits, kv } from "../db/schema.ts";
import { PICO_PER_USD } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { base58Encode } from "./constants.ts";
import { loadSigner } from "./keys.ts";
import { sendAndConfirm, withRetry } from "./rpc.ts";

// "$TRLS paid for inference is burned" (update `trls`, UPDATES.md). A $TRLS deposit that was credited is a payment for
// inference: its balance can only be spent on calls and is never paid back out. The job "trls-burn" burns the tokens of
// every credited deposit from the escrow wallet's own token account, with the token program's burn instruction, so
// each burn is an ordinary transaction anyone can read on chain, and the router keeps no pile of customers' tokens.
//
// What is burned is a total, not a list: the tokens of all credited deposits, less what has been burned already. A
// deposit credited below its value because of the per-deposit limit is burned in the same proportion; the rest of its
// tokens stay in the escrow wallet for the operator to send back. One burn is in flight at a time, and its signature is
// written down BEFORE it is sent, so a crash between sending and recording cannot burn the same tokens twice: the next
// pass looks that signature up first.

/** How many finalized burns the state keeps a line for (the total is kept whatever this is): the burn tracker lists them. */
export const BURN_HISTORY = 500;

type Pending = { signature: string; amount: string; blockhash: string };
type State = { burned: string; pending?: Pending; txs: { signature: string; amount: string; at: number }[] };

const stateKey = (ctx: Pick<Ctx, "cfg">, mint: string) => `trls-burn:${ctx.cfg.chain.network}:${mint}`;

export async function burnState(ctx: Pick<Ctx, "cfg" | "db">, mint: string): Promise<State> {
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, stateKey(ctx, mint)));
  const v = row?.value as Partial<State> | undefined;
  return { burned: /^\d+$/.test(String(v?.burned)) ? String(v!.burned) : "0", pending: v?.pending, txs: Array.isArray(v?.txs) ? v!.txs : [] };
}
async function save(ctx: Ctx, mint: string, state: State) {
  await ctx.db.insert(kv).values({ key: stateKey(ctx, mint), value: state }).onConflictDoUpdate({ target: kv.key, set: { value: state, updatedAt: new Date() } });
}

/** Raw token units of one credited deposit that its credit paid for: all of them, or the capped share. */
export function burnShare(raw: bigint, price18: bigint, credited: bigint, decimals: number, haircutBps: number): bigint {
  const gross = (raw * price18 * PICO_PER_USD) / (10n ** BigInt(decimals) * 10n ** 18n);
  const net = (gross * BigInt(10_000 - haircutBps)) / 10_000n;
  if (credited <= 0n) return 0n;
  return net <= 0n || credited >= net ? raw : (raw * credited) / net;
}

/** The tokens every credited deposit paid, in raw units. */
export async function burnTarget(ctx: Ctx): Promise<bigint> {
  const trls = ctx.cfg.trlsEscrow!;
  const rows = await ctx.db.select({ raw: escrowDeposits.rawAmount, price18: escrowDeposits.price18, credited: escrowDeposits.credited }).from(escrowDeposits).where(and(eq(escrowDeposits.token, trls.address), eq(escrowDeposits.status, "credited"), isNotNull(escrowDeposits.credited), isNotNull(escrowDeposits.price18)));
  return rows.reduce((sum, r) => sum + burnShare(BigInt(r.raw), BigInt(r.price18!), r.credited!, trls.decimals, trls.haircutBps), 0n);
}

/** One pass of the burn job. Does nothing on a process without the escrow wallet's key. */
export async function runTrlsBurn(ctx: Ctx) {
  const trls = ctx.cfg.trlsEscrow, escrowAddress = ctx.cfg.escrow.address;
  if (!trls || !escrowAddress) return { skipped: "$TRLS is not accepted" };
  if (!ctx.cfg.trlsBurn.key) return { skipped: "no burn key on this process" };
  const owner = loadSigner(ctx.cfg.trlsBurn.key);
  if (owner.publicKey.toBase58() !== escrowAddress) throw new Error("TRLS_BURN_PRIVATE_KEY is not the key of ESCROW_ADDRESS.");
  const payer = ctx.cfg.trlsBurn.feePayer === "anchorer" ? ctx.chain.signer("anchorer") : owner;
  if (!payer) throw new Error("TRLS_BURN_FEE_PAYER=anchorer needs the anchorer key on this process.");
  const conn = ctx.chain.connection;
  const mint = new PublicKey(trls.address);
  const mintInfo = await withRetry(() => conn.getAccountInfo(mint));
  if (!mintInfo) throw new Error("the $TRLS mint was not found");
  const program = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const account = getAssociatedTokenAddressSync(mint, owner.publicKey, true, program);

  const state = await burnState(ctx, trls.address);
  if (state.pending) {
    const p = state.pending;
    const [status] = (await withRetry(() => conn.getSignatureStatuses([p.signature], { searchTransactionHistory: true }))).value;
    if (status?.err) state.pending = undefined; // failed on chain: nothing was burned
    else if (status?.confirmationStatus === "finalized") {
      state.burned = (BigInt(state.burned) + BigInt(p.amount)).toString();
      state.txs = [...state.txs, { signature: p.signature, amount: p.amount, at: Math.floor(Date.now() / 1000) }].slice(-BURN_HISTORY);
      state.pending = undefined;
      log.info("trls burn finalized", { signature: p.signature, amount: p.amount });
    } else if (!status && !(await withRetry(() => conn.isBlockhashValid(p.blockhash, { commitment: "finalized" }))).value) state.pending = undefined; // never landed and no longer can
    else return { waiting: p.signature };
    await save(ctx, trls.address, state);
  }

  // The escrow wallet's token account must exist before a wallet can send to it.
  const held = await withRetry(() => conn.getAccountInfo(account));
  if (!held) {
    const tx = new Transaction({ feePayer: payer.publicKey }).add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, account, owner.publicKey, mint, program));
    const r = await sendAndConfirm(conn, tx, [payer], "finalized");
    return { created_account: account.toBase58(), signature: r.signature };
  }
  const balance = held.data.readBigUInt64LE(64);
  const due = (await burnTarget(ctx)) - BigInt(state.burned);
  const amount = due < balance ? due : balance;
  if (amount <= 0n) return { burned: 0, total: state.burned };

  const { blockhash, lastValidBlockHeight } = await withRetry(() => conn.getLatestBlockhash("finalized"));
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(createBurnCheckedInstruction(account, mint, owner.publicKey, amount, trls.decimals, [], program));
  tx.sign(...(payer === owner ? [owner] : [payer, owner]));
  const signature = base58Encode(tx.signature!);
  state.pending = { signature, amount: amount.toString(), blockhash };
  await save(ctx, trls.address, state); // before sending: see the note at the top
  await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 5 });
  return { sent: signature, amount: amount.toString() };
}
