// Deposit pings (docs/Trellis_Backend.md §5.1, B123): one notice per credited deposit, for the owner of the key it funded.
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { chainEvents, keys, kv, ledger } from "../db/schema.ts";
import { balanceOf } from "../ledger/ledger.ts";
import { picoToUsdString } from "../lib/money.ts";
import { log } from "../lib/util.ts";
import { linkedAlertTargets } from "../telegram/delivery.ts";
import { depositRef } from "./credits-indexer.ts";
import { formatUsdc } from "./credits.ts";

// The credits indexer (credits-indexer.ts) turns every finalized trellis_credits `Deposited` event into a ledger credit on
// the key's account (ledger.ref = deposit:<signature>:<index>). This job (BullMQ "deposit-pings", every 5s, worker role
// only) follows it: for each deposit credited within the last day it inserts one permanent marker, kv key
// deposit-ping:<chain id>:<signature>:<index>, holding the account id, the deposit id, the notice time and the credited USD
// amount. The inbox (src/inbox/deposit-pings.ts) shows the markers to the account's owner as "Deposit credited", and the
// same notice goes once to the account's linked Telegram chats through the alert delivery path (src/telegram/delivery.ts),
// with the balance as it stands. The marker is what makes a deposit notify exactly once: it is claimed before anything is
// sent, so a crash or a failed send can lose a Telegram message but never repeats one. Nothing here credits anything.

export const PING_WINDOW_MS = 86_400_000;
export const PING_BATCH = 100;

/** `id` is the deposit id: `<transaction signature>:<event index>`. The inbox reads the same prefix. */
export const depositPingKey = (ctx: Ctx, id: string) => `deposit-ping:${ctx.cfg.chain.id}:${id}`;
export const depositId = (signature: string, index: number) => `${signature}:${index}`;
export type DepositPing = { accountId: string; depositId: string; at: string; amount: string };
const money = (pico: bigint) => {
  const cents = ((pico < 0n ? -pico : pico) + 5_000_000_000n) / 10_000_000_000n;
  return `${pico < 0n ? "-" : ""}$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};
export function depositPingText(amount: string, symbol: string, credited: bigint, balance: bigint) {
  const [whole, fraction] = amount.split(".");
  const tokens = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
  return `Your deposit of ${tokens} ${symbol === "TRLS" ? "$TRLS" : symbol} is credited: ${money(credited)} added. Balance: ${money(balance)}.`;
}

/**
 * One pass: claim a marker for every deposit the indexer credited in the last day that has none yet (at most PING_BATCH,
 * oldest first), then send each new notice to the account's linked chats. Returns how many were recorded and sent.
 */
export async function runDepositPings(ctx: Ctx, fetchImpl?: typeof fetch, now = Date.now()) {
  if (!ctx.cfg.depositPingsEnabled || ctx.cfg.runtimeRole === "api") return { skipped: true };
  const prefix = depositPingKey(ctx, "");
  const credited = await ctx.db
    .select({ txHash: chainEvents.txHash, logIndex: chainEvents.logIndex, args: chainEvents.args })
    .from(chainEvents)
    .where(and(
      eq(chainEvents.contract, "credits"), eq(chainEvents.event, "Deposited"), eq(chainEvents.processed, true), gt(chainEvents.processedAt, new Date(now - PING_WINDOW_MS)),
      sql`not exists (select 1 from ${kv} where ${kv.key} = ${prefix} || ${chainEvents.txHash} || ':' || ${chainEvents.logIndex}::text)`,
    ))
    .orderBy(asc(chainEvents.processedAt), asc(chainEvents.txHash), asc(chainEvents.logIndex))
    .limit(PING_BATCH);
  let recorded = 0, sent = 0;
  for (const e of credited) {
    const args = e.args as { keyHash?: string; amount?: string };
    const chainKeyHash = (args.keyHash ?? "").toLowerCase().replace(/^0x/, "");
    // The ledger line is the fact: no credit under this deposit's reference, no notice.
    const [line] = await ctx.db.select({ accountId: ledger.accountId, amount: ledger.amount }).from(ledger).where(eq(ledger.ref, depositRef(e.txHash, e.logIndex)));
    const [key] = chainKeyHash ? await ctx.db.select({ keyHash: keys.keyHash, accountId: keys.accountId }).from(keys).where(eq(keys.chainKeyHash, chainKeyHash)) : [];
    if (!line || line.amount <= 0n) continue;
    const id = depositId(e.txHash, e.logIndex);
    const ping: DepositPing = { accountId: line.accountId, depositId: id, at: new Date(now).toISOString(), amount: picoToUsdString(line.amount) };
    const claimed = await ctx.db.insert(kv).values({ key: depositPingKey(ctx, id), value: ping }).onConflictDoNothing().returning({ key: kv.key });
    if (!claimed.length) continue; // another worker has it
    recorded++;
    // Only for the account that was credited, and only while the funded key still belongs to it.
    if (!key || key.accountId !== line.accountId || !/^\d+$/.test(args.amount ?? "")) continue;
    try {
      const { balance } = await balanceOf(ctx.db, line.accountId);
      const text = depositPingText(formatUsdc(BigInt(args.amount!)), "USDC", line.amount, balance);
      for (const target of await linkedAlertTargets(ctx, line.accountId, key.keyHash, text, fetchImpl)) if (await target.send()) sent++;
    } catch (err) {
      log.warn("deposit ping not delivered", { error: (err as Error).name });
    }
  }
  return { recorded, sent };
}
