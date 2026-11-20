import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, chainEvents, keys, teamMembers } from "../db/schema.ts";
import { deriveKey, KEY_RE } from "../solana/keys.ts";
import { fail } from "../lib/errors.ts";
import { refuseEndedKey } from "./key-end-dates.ts";
import { ensureAccount } from "../ledger/ledger.ts";
import { log, sha256 } from "../lib/util.ts";
import { decodeWalletAddress, decodeWalletSignature, verifyWalletSignature, WALLET_ADDRESS_RE, WALLET_AUTH_VERSION, WALLET_SIGNATURE_RE, walletAuthMessage } from "../lib/wallet-sig.ts";
import { processEvents } from "../solana/indexer.ts";
import { reconcileKey } from "../solana/credits-indexer.ts";
import { creditsProgram, readCreditAccount } from "../solana/credits.ts";

export type KeyRow = typeof keys.$inferSelect;
/**
 * Team roles. owner > admin > dev > viewer; agent is API-only. `member` is the older default for a key in a team: it may call
 * the API and read settings. A management key acts as owner. See roleAllowed for how the newer roles map onto route lists.
 */
export type Role = "owner" | "admin" | "dev" | "member" | "viewer" | "agent";
export const ROLE_RANK: Record<Role, number> = { agent: 0, viewer: 0, member: 1, dev: 1, admin: 2, owner: 3 };

/**
 * Whether `role` may use a route that allows `allowed`. Route lists predate dev and agent, so: a dev may do what a member or a
 * viewer may (call the API, read settings and usage, plus create keys where a route lists dev); an agent may only use routes
 * that make calls (they list member but not viewer), never the ones that read or manage the account.
 */
export function roleAllowed(role: Role, allowed: readonly Role[]) {
  if (allowed.includes(role)) return true;
  if (role === "dev") return allowed.includes("member") || allowed.includes("viewer");
  if (role === "agent") return allowed.includes("member") && !allowed.includes("viewer");
  return false;
}

export const accountIdFor = (chainKeyHash: string) => `k_${chainKeyHash.slice(2, 34)}`;
/**
 * The account a wallet owns: `w_` + its base58 address, exactly as presented (base58 is case-sensitive). The same id the
 * per-call payer path (src/solana/percall.ts) derives for a paying wallet, so a wallet that signs in and a wallet that
 * pays per call are one account.
 */
export const walletAccountId = (address: string) => `w_${address}`;

export function bearer(header: string | undefined | null) {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}

/** Register a root key (its own account). Idempotent. Claims any deposits already made to it. */
export async function registerRootKey(ctx: Ctx, secret: string, name = "") {
  const d = deriveKey(secret);
  const accountId = accountIdFor(d.chainKeyHash);
  await ctx.db.transaction(async (tx) => {
    await ensureAccount(tx, accountId, "key");
    await tx
      .insert(keys)
      .values({
        keyHash: d.keyHash,
        chainKeyHash: d.chainKeyHash,
        keyAddress: d.keyAddress,
        accountId,
        name,
        label: d.label,
        management: true,
        rpm: ctx.cfg.limits.defaultRpm || null,
        tpm: ctx.cfg.limits.defaultTpm || null,
      })
      .onConflictDoNothing();
  });
  // Deposits made before the key existed here (security re-review RR-12): the events on file for it are applied now
  // (they were parked as `unknown_key`), and whatever else the chain holds for it is credited from its CreditAccount.
  // Both go through the per-key lock and are bounded by the on-chain deposited_total; neither credits a key whose
  // on-chain account was closed and refunded before it was registered, and a closure already on file for the key hash
  // gets the key (which freezes it) before anything is credited.
  await processEvents(ctx, { chainKeyHash: d.chainKeyHash, retry: true }).catch((e) => log.warn("key registration: applying earlier deposits failed; the indexer retries", { error: (e as Error).message.slice(0, 160) }));
  await reconcileKey(ctx, { keyHash: d.keyHash, chainKeyHash: d.chainKeyHash, accountId, keyAddress: d.keyAddress }).catch((e) => log.warn("key registration: reading the key's on-chain balance failed; the indexer's sweep retries", { error: (e as Error).message.slice(0, 160) }));
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, d.keyHash));
  return row;
}

/** Look up a presented API key. Unknown but well-formed keys that already have on-chain deposits
 *  are registered on the spot: deposit first, call immediately, no account needed. */
export async function resolveKey(ctx: Ctx, secret: string): Promise<KeyRow | null> {
  if (!KEY_RE.test(secret)) return null;
  const keyHash = sha256(secret);
  const [row] = await ctx.db.select().from(keys).where(eq(keys.keyHash, keyHash));
  if (row) {
    if (row.disabled) fail(401, "This API key is disabled.", "key_disabled");
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) refuseEndedKey(ctx, row.expiresAt); // update 16 says when it ended
    return row;
  }
  const d = deriveKey(secret);
  // The event carries the key hash 0x-prefixed; the derived hash is bare hex (RR-12: they were compared as they came
  // and never matched, so "deposit first, call immediately" did not work).
  const pending = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(chainEvents)
    .where(and(eq(chainEvents.processed, false), sql`${chainEvents.args}->>'keyHash' = ${"0x" + d.chainKeyHash.replace(/^0x/, "")}`));
  // No event on file (the indexer may be behind, or the deposit's transaction quarantined): the chain itself is asked.
  if (!pending[0]?.n && !(await fundedOnChain(ctx, d.chainKeyHash))) return null;
  return registerRootKey(ctx, secret);
}

// Whether an unknown key hash holds deposits on chain. Unknown keys arrive unauthenticated, so the lookups are bounded:
// a short negative cache per key hash and a ceiling on chain reads per second for the whole process.
const notFunded = new Map<string, number>();
let lookups = { second: 0, n: 0 };
const UNKNOWN_KEY_LOOKUPS_PER_SECOND = 5;
async function fundedOnChain(ctx: Ctx, chainKeyHash: string): Promise<boolean> {
  const program = creditsProgram(ctx.cfg);
  if (!program) return false;
  const now = Date.now();
  if ((notFunded.get(chainKeyHash) ?? 0) > now) return false;
  const second = Math.floor(now / 1000);
  if (lookups.second !== second) lookups = { second, n: 0 };
  if (++lookups.n > UNKNOWN_KEY_LOOKUPS_PER_SECOND) return false;
  try {
    const account = await readCreditAccount(ctx.chain.connection, program, chainKeyHash, "finalized");
    if (account && account.depositedTotal > 0n) return true;
  } catch { /* an RPC failure is not a deposit */ }
  if (notFunded.size > 10_000) notFunded.clear();
  notFunded.set(chainKeyHash, now + 30_000);
  return false;
}

export async function requireKey(ctx: Ctx, authorization: string | undefined | null) {
  const secret = bearer(authorization);
  if (!secret) fail(401, "Provide an API key as `Authorization: Bearer sk-tr-v1-...`.", "missing_key");
  const key = await resolveKey(ctx, secret);
  if (!key) fail(401, "Unknown API key. Create one (POST /api/v1/keys) or deposit USDC to its key hash first.", "invalid_key");
  return key;
}

export async function roleOf(ctx: Ctx, key: KeyRow): Promise<Role> {
  if (key.management) return "owner";
  if (!key.teamId) return "member";
  const [m] = await ctx.db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, key.teamId), eq(teamMembers.keyHash, key.keyHash)));
  return (m?.role as Role) ?? "member";
}

export async function requireRole(ctx: Ctx, key: KeyRow, allowed: Role[]) {
  const role = await roleOf(ctx, key);
  if (!roleAllowed(role, allowed)) fail(403, `This key's role (${role}) cannot do that.`, "forbidden");
  return role;
}

// Wallet authentication for per-call payers spending their change balance and for host operators:
//   X-Wallet-Auth: <base58 address>:<unixSeconds>:<base58 signature>
// where signature = ed25519, by the wallet whose public key is the address, over the UTF-8 bytes of
//   trellis:wallet-auth:v2\n<METHOD>\n<host>\n<path>\n<unixSeconds>\n<sha256 hex>
// (src/lib/wallet-sig.ts walletAuthMessage; security review TR-20). METHOD and path (query string included) are this
// request's; host is this router's own public host, from its configuration and never from the request, so a signature
// made for one router, one route or one method is nothing anywhere else. The earlier message, "trellis:<time>:<sha256>",
// is not accepted. Replay protection keys on everything the signature authorizes (address, timestamp, method, host,
// path, hash), not on the signature bytes. It is shared across replicas through Redis (SET NX); a router without Redis
// keeps it per process, which production does not allow.
const seen = new Map<string, number>();
async function firstUse(ctx: Ctx, id: string) {
  const redis = (ctx.cache as unknown as { redis?: import("ioredis").Redis }).redis;
  if (redis) return (await redis.set(`walletauth:${id}`, "1", "PX", 600_000, "NX")) === "OK";
  // Per process only: N replicas would each accept the same header once. Production has to run the shared cache.
  if (ctx.cfg.env === "production") fail(503, "Wallet-signed requests need the shared replay cache (Redis), which is not available.", "wallet_auth_unavailable");
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  if (seen.size > 50_000) for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);
  return true;
}

/**
 * The hosts a wallet may name in X-Wallet-Auth for this router: the host of PUBLIC_BASE_URL (what the sign-in challenge
 * calls `domain`), the host of SITE_URL when the dashboard is served under another name, and the router's own onion
 * address. All from configuration: the request's Host header is never consulted.
 */
export function walletAuthHosts(cfg: Ctx["cfg"]): string[] {
  const hosts = new Set<string>();
  for (const url of [cfg.publicUrl, cfg.siteUrl]) { try { hosts.add(new URL(url).host.toLowerCase()); } catch { /* not a URL: not a host */ } }
  if (cfg.onion?.address) hosts.add(cfg.onion.address.toLowerCase());
  return [...hosts];
}

/** What of a request X-Wallet-Auth is bound to: its method and its path with the query string, as received. */
export type WalletAuthTarget = { method: string; path: string };
export function walletAuthTarget(c: { req: { method: string; url: string } }): WalletAuthTarget {
  const u = new URL(c.req.url);
  return { method: c.req.method.toUpperCase(), path: u.pathname + u.search };
}

/**
 * Verify X-Wallet-Auth for the request `c` (or an explicit `{ method, path }`) and the hash the route binds. Single
 * use: the same (address, timestamp, method, host, path, hash) is refused the second time.
 */
export async function walletAuth(ctx: Ctx, header: string, bodySha: string, c: { req: { method: string; url: string } } | WalletAuthTarget) {
  const [address, ts, sig, ...rest] = header.split(":");
  if (rest.length || !WALLET_ADDRESS_RE.test(address ?? "") || !/^\d{1,12}$/.test(ts ?? "") || !WALLET_SIGNATURE_RE.test(sig ?? "") || !decodeWalletAddress(address!) || !decodeWalletSignature(sig!))
    fail(401, "X-Wallet-Auth must be <base58 address>:<unixSeconds>:<base58 ed25519 signature>.", "invalid_wallet_auth");
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (age > 300) fail(401, "X-Wallet-Auth timestamp is outside the 5-minute window.", "invalid_wallet_auth");
  const target = "req" in c ? walletAuthTarget(c) : { method: c.method.toUpperCase(), path: c.path };
  const hosts = walletAuthHosts(ctx.cfg);
  let host: string | null = null;
  try { host = hosts.find((h) => verifyWalletSignature(address!, walletAuthMessage({ method: target.method, host: h, path: target.path, timestamp: ts!, bodySha }), sig!)) ?? null; } catch { host = null; }
  if (!host)
    fail(401, `X-Wallet-Auth signature does not match this request. Sign "${WALLET_AUTH_VERSION}\\n<METHOD>\\n<host>\\n<path>\\n<unixSeconds>\\n<sha256 hex>" for this method, this path (with its query string) and host ${hosts[0]}; the v1 message "trellis:<time>:<sha256>" is no longer accepted.`, "invalid_wallet_auth", { version: WALLET_AUTH_VERSION, host: hosts[0], method: target.method, path: target.path });
  if (!(await firstUse(ctx, sha256(`${address!}|${ts}|${target.method}|${host}|${target.path}|${bodySha}`)))) fail(401, "X-Wallet-Auth signature was already used.", "invalid_wallet_auth");
  const accountId = walletAccountId(address!);
  const [acct] = await ctx.db.select().from(accounts).where(eq(accounts.id, accountId));
  return { accountId, wallet: address!, exists: !!acct };
}
