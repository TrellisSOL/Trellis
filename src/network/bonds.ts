import { and, eq, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import type { Config } from "../config.ts";
import { providers } from "../db/schema.ts";
import { hostBondCursor, hostBondProjection } from "./bond-schema.ts";
import { activeBond, bondHostId, bondScope, DEFAULT_MIN_BOND, type BondHost, type BondParameters, type BondSlash } from "./bond-state.ts";
export const BOND_MAX_AGE_MS = 120_000;
export const bondFresh = (at?: Date) => !!at && Date.now() >= at.getTime() && Date.now() - at.getTime() <= BOND_MAX_AGE_MS;
export type BondWeightSettings = { enabled: boolean; fullUsdc: number; scope: string };
export async function readRoutingBondEvidence(db: Db, p: { id: string; operator: string | null }, settings?: BondWeightSettings): Promise<{ bond: bigint; bondCheckedAt: number }> {
  const none = { bond: 0n, bondCheckedAt: 0 };
  if (!settings?.enabled || !p.operator) return none;
  const [cursor] = await db.select().from(hostBondCursor).where(eq(hostBondCursor.scope, settings.scope));
  if (!bondFresh(cursor?.checkedAt)) return none;
  let hostId: string;
  try { hostId = bondHostId(p.operator); } catch { return none; }
  const rows = await db.select().from(hostBondProjection).where(and(eq(hostBondProjection.scope, settings.scope), or(and(eq(hostBondProjection.kind, "host"), eq(hostBondProjection.id, hostId)), eq(hostBondProjection.kind, "parameters"))));
  const host = rows.find(r => r.kind === "host" && r.id === hostId)?.data as BondHost | undefined;
  const params = rows.find(r => r.kind === "parameters")?.data as BondParameters | undefined;
  if (!host || host.operator !== p.operator || host.delisted) return none;
  const active = activeBond(host);
  return { bond: active >= BigInt(params?.minBond ?? DEFAULT_MIN_BOND) ? active : 0n, bondCheckedAt: cursor.checkedAt.getTime() };
}
export async function readRoutingBond(db: Db, p: { id: string; operator: string | null }, settings?: BondWeightSettings) {
  return (await readRoutingBondEvidence(db, p, settings)).bond;
}
/** Up to 1.5x. Probation stays below the same host's unboosted graduated weight. */
export function bondedWeight(base: number, nonProbation: number, probation: boolean, amount?: bigint, settings?: { enabled: boolean; fullUsdc: number }) {
  if (!settings?.enabled || !amount || amount <= 0n) return base;
  const full = BigInt(Math.ceil(settings.fullUsdc * 1_000_000));
  if (full <= 0n) return base;
  const scaled = Number((amount >= full ? full : amount) * 1_000_000n / full) / 1_000_000;
  const boosted = base * (1 + 0.5 * scaled);
  return probation ? Math.min(nonProbation, boosted) : boosted;
}
export function routingBondSettings(cfg: Config): BondWeightSettings {
  return { enabled: cfg.hostBonds.enabled, fullUsdc: cfg.hostBonds.fullUsdc, scope: bondScope(cfg) };
}
/** Explorer link for a transaction signature; devnet gets its cluster flag. */
const txLink = (hash: string, network?: string) => `https://explorer.solana.com/tx/${hash}${network && !network.startsWith("solana:5eykt4") ? "?cluster=devnet" : ""}`;
export async function publicHostBond(ctx: Ctx, id: string) {
  if (!ctx.cfg.hostBonds.enabled) return undefined;
  const scope = bondScope(ctx.cfg);
  const [p] = await ctx.db.select({ operator: providers.operator, networkHost: providers.networkHost }).from(providers).where(eq(providers.id, id));
  if (!p?.networkHost) return null;
  let hostId: string | null = null;
  try { hostId = p.operator ? bondHostId(p.operator) : null; } catch { hostId = null; }
  const [cursor] = await ctx.db.select().from(hostBondCursor).where(eq(hostBondCursor.scope, scope));
  const [hostRow] = hostId ? await ctx.db.select().from(hostBondProjection).where(and(eq(hostBondProjection.scope, scope), eq(hostBondProjection.kind, "host"), eq(hostBondProjection.id, hostId))) : [];
  const h = hostRow?.data as BondHost | undefined;
  const matched = !!h && !!p.operator && h.operator === p.operator;
  const rows = hostId ? await ctx.db.select().from(hostBondProjection).where(and(eq(hostBondProjection.scope, scope), eq(hostBondProjection.kind, "slash"), sql`${hostBondProjection.data}->>'hostId' = ${hostId}`)).orderBy(sql`${hostBondProjection.data}->>'executableAt' desc`) : [];
  const slashes = rows.filter(r => (r.data as BondSlash).hostId === hostId).map(r => ({ id: r.id, host_id: (r.data as BondSlash).hostId, amount_units: (r.data as BondSlash).amount, reason: (r.data as BondSlash).reason, bps: (r.data as BondSlash).bps, evidence_root: (r.data as BondSlash).evidenceRoot, executable_at: new Date(Number((r.data as BondSlash).executableAt) * 1000).toISOString(), dispute_status: (r.data as BondSlash).disputeStatus, status: (r.data as BondSlash).status, transactions: (r.data as BondSlash).transactions.map(t => ({ ...t, url: txLink(t.hash, ctx.cfg.chain.network) })) }));
  return { host_id: hostId, program: ctx.cfg.hostBonds.address, contract: ctx.cfg.hostBonds.address, chain_id: ctx.cfg.chain.id, decimals: 6, asset: "USDC", matched_operator: matched,
    amount_units: matched ? h.bond : "0", active_units: matched ? activeBond(h).toString() : "0", delisted: matched ? h.delisted : false,
    unbonding: matched && h.availableAt ? { amount_units: h.unbond, available_at: new Date(Number(h.availableAt) * 1000).toISOString() } : null,
    indexed_block: cursor?.block.toString() ?? null, fresh: bondFresh(cursor?.checkedAt), checked_at: cursor?.checkedAt.toISOString() ?? null, slashes };
}
export function hostBondRoutes(app: Hono, ctx: Ctx) {
  if (!ctx.cfg.hostBonds.enabled) return;
  app.get("/api/v1/network/bonds", async c => {
    const scope = bondScope(ctx.cfg);
    const [cursor] = await ctx.db.select().from(hostBondCursor).where(eq(hostBondCursor.scope, scope));
    const rows = await ctx.db.select().from(hostBondProjection).where(eq(hostBondProjection.scope, scope));
    const hosts = rows.filter(r => r.kind === "host").map(r => r.data as BondHost);
    const params = rows.find(r => r.kind === "parameters")?.data as BondParameters | undefined;
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ data: { contract: ctx.cfg.hostBonds.address, program: ctx.cfg.hostBonds.address, chain_id: ctx.cfg.chain.id, asset: "USDC", decimals: 6, definition: "A work deposit held by trellis_bond; public on-chain data.",
      indexed_block: cursor?.block.toString() ?? null, fresh: bondFresh(cursor?.checkedAt), minimum_units: params?.minBond ?? DEFAULT_MIN_BOND,
      total_units: hosts.reduce((a, h) => a + BigInt(h.bond), 0n).toString(), active_units: hosts.reduce((a, h) => a + activeBond(h), 0n).toString(),
      hosts: hosts.length, pending_slashes: rows.filter(r => r.kind === "slash" && (r.data as BondSlash).status === "pending").length } });
  });
}
