import { and, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { kv, providers } from "../db/schema.ts";
import { walletAccountId } from "../api/auth.ts";
import { fail } from "../lib/errors.ts";
import { log } from "../lib/util.ts";
import { isWalletAddress, isWalletSignature, WALLET_ADDRESS_RE } from "../lib/wallet-sig.ts";
import { SIGNATURE_RE } from "../solana/constants.ts";
import { toolListings } from "../tools/schema.ts";
import { REGISTRATION_RENT_SOL, REGISTRATION_TYPE } from "./agent-registry.ts";
import { identityChain, type IdentityChain } from "./chain.ts";
import { accountWallets, identityIdPattern, newIdentityId, receiptKeysUrl, registrationUrl, registryOrFail } from "./identity.ts";

// Solana Agent Registry identities for the two other things a caller pays through this router: a network host and a
// tool listing. They register exactly as an agent key does (src/identity/identity.ts, the same chain adapter): in owner
// mode the router prepares the transaction for the owner's wallet and later reads its signature; in registrar mode the
// agent-identity worker sends it. A host's owner is always its operator wallet; a tool's owner is a wallet linked to
// the account that listed it, or the wallet that account names.
//
// agent_identities is keyed by an API key, so the progress of these registrations lives in the generic kv table:
//   identity:subject:<kind>:<ref>       SubjectState (ref: the provider id or the tool listing id)
//   identity:subject-id:<public id>     { kind, ref }: resolves the public id in the registration file URL

export type SubjectKind = "host" | "tool";
type HostRow = typeof providers.$inferSelect;
type ListingRow = typeof toolListings.$inferSelect;

export type Subject = {
  kind: SubjectKind;
  /** The provider id or the tool listing id. */
  ref: string;
  /** An admitted host (probation, shadow or live) or a listed tool: only an active subject registers. */
  active: boolean;
  /** The account that controls the subject: the operator wallet's account, or the account that listed the tool. */
  accountId: string | null;
  /** Host only: the operator's base58 wallet. */
  operator: string | null;
  host?: HostRow;
  tool?: ListingRow;
};

export type SubjectStatus = "none" | "awaiting_owner" | "queued" | "submitted" | "registered" | "failed";
export type SubjectState = {
  v: 1;
  /** Random public id in the registration file URL; independent of the provider and listing ids. */
  id: string;
  kind: SubjectKind;
  ref: string;
  status: SubjectStatus;
  mode: "owner" | "registrar" | null;
  registry: string | null;
  agentId: string | null;
  ownerAddress: string | null;
  txHash: string | null;
  error: string | null;
  updatedAt: string;
};

export const ADMITTED_HOST_STATUSES = ["probation", "shadow", "live"];
const LISTING_ID = /^tl_[0-9a-f]{24}$/;
const STATUSES: SubjectStatus[] = ["none", "awaiting_owner", "queued", "submitted", "registered", "failed"];
const STATE_PREFIX = "identity:subject:";
const stateKey = (kind: SubjectKind, ref: string) => `${STATE_PREFIX}${kind}:${ref}`;
const idKey = (id: string) => `identity:subject-id:${id}`;

const ownerWallet = z.string().regex(WALLET_ADDRESS_RE).refine(isWalletAddress, "expected a base58 Solana address (32 bytes)");
const txHash = z.string().regex(SIGNATURE_RE, "tx_hash must be a base58 transaction signature").refine(isWalletSignature, "tx_hash must be a base58 64-byte transaction signature");
const providerId = z.string().min(1).max(100);
/** Host bodies are signed by the operator wallet (X-Wallet-Auth), so they name the host they are for. */
export const hostRegisterBody = z.strictObject({ provider_id: providerId });
export const hostConfirmBody = z.strictObject({ provider_id: providerId, tx_hash: txHash });
export const toolRegisterBody = z.strictObject({ owner_wallet: ownerWallet.optional() });
export const toolConfirmBody = z.strictObject({ tx_hash: txHash });

/** A network host by provider id; null when the provider is not a network host. */
export async function hostSubject(ctx: Ctx, id: string): Promise<Subject | null> {
  if (!id || id.length > 100) return null;
  const [host] = await ctx.db.select().from(providers).where(and(eq(providers.id, id), eq(providers.networkHost, true)));
  if (!host) return null;
  const operator = isWalletAddress(host.operator) ? host.operator : null;
  return { kind: "host", ref: host.id, active: !!operator && ADMITTED_HOST_STATUSES.includes(host.status), accountId: operator ? walletAccountId(operator) : null, operator, host };
}

/** A tool listing by id; null when there is none or it was removed. */
export async function toolSubject(ctx: Ctx, id: string): Promise<Subject | null> {
  if (!LISTING_ID.test(id)) return null;
  const [tool] = await ctx.db.select().from(toolListings).where(eq(toolListings.id, id));
  if (!tool || tool.status === "removed") return null;
  return { kind: "tool", ref: tool.id, active: tool.status === "listed", accountId: tool.accountId, operator: null, tool };
}

const loadSubject = (ctx: Ctx, kind: SubjectKind, ref: string) => (kind === "host" ? hostSubject(ctx, ref) : toolSubject(ctx, ref));

function readState(value: unknown): SubjectState | null {
  const s = value as Partial<SubjectState> | null;
  if (!s || typeof s !== "object" || s.v !== 1 || typeof s.id !== "string" || !identityIdPattern.test(s.id)) return null;
  if ((s.kind !== "host" && s.kind !== "tool") || typeof s.ref !== "string" || !STATUSES.includes(s.status as SubjectStatus)) return null;
  return s as SubjectState;
}

export async function subjectState(db: Db | Tx, kind: SubjectKind, ref: string): Promise<SubjectState | null> {
  const [row] = await db.select({ value: kv.value }).from(kv).where(eq(kv.key, stateKey(kind, ref)));
  return row ? readState(row.value) : null;
}

/** The subject's state row, created with a fresh public id on first use, and the row that resolves that id. */
async function ensureState(ctx: Ctx, subject: Subject): Promise<SubjectState> {
  const fresh: SubjectState = { v: 1, id: newIdentityId(), kind: subject.kind, ref: subject.ref, status: "none", mode: null, registry: null, agentId: null, ownerAddress: null, txHash: null, error: null, updatedAt: new Date().toISOString() };
  await ctx.db.insert(kv).values({ key: stateKey(subject.kind, subject.ref), value: fresh }).onConflictDoNothing();
  const state = await subjectState(ctx.db, subject.kind, subject.ref);
  if (!state) fail(500, "The identity state of this subject could not be read.", "internal_error");
  await ctx.db.insert(kv).values({ key: idKey(state.id), value: { kind: state.kind, ref: state.ref } }).onConflictDoNothing();
  return state;
}

/** Write `patch` over the state, only while its status is one of `from`. False when another request moved it first. */
async function moveState(db: Db | Tx, state: SubjectState, from: SubjectStatus[], patch: Partial<SubjectState>) {
  const now = new Date();
  const next: SubjectState = { ...state, ...patch, updatedAt: now.toISOString() };
  const moved = await db.update(kv).set({ value: next, updatedAt: now })
    .where(and(eq(kv.key, stateKey(state.kind, state.ref)), sql`${kv.value}->>'status' in (${sql.join(from.map(s => sql`${s}`), sql`, `)})`)).returning({ key: kv.key });
  return moved.length > 0;
}

/** What anyone may read about a subject's identity. `detail` adds what its owner sees while a registration is under way. */
export function subjectIdentityJson(ctx: Ctx, subject: Subject, state: SubjectState | null, detail = false) {
  const registered = state?.status === "registered";
  return {
    kind: subject.kind,
    id: subject.ref,
    active: subject.active,
    status: state?.status ?? "none",
    mode: state?.mode ?? null,
    registry: state?.registry ?? ctx.cfg.identity.registry.id,
    agent_id: registered || detail ? state?.agentId ?? null : null,
    registration_url: state ? registrationUrl(ctx, state.id) : null,
    ...(detail ? { owner_address: state?.ownerAddress ?? null, tx_hash: state?.txHash ?? null, error: state?.error ?? null } : {}),
  };
}

const paths = (subject: Subject) => (subject.kind === "host" ? `/api/v1/network/hosts/${encodeURIComponent(subject.ref)}/identity` : `/api/v1/tools/listings/${subject.ref}/identity`);

/**
 * Owner mode: a transaction for the owner's wallet. A host's owner is its operator wallet, whatever the caller sends; a
 * tool's owner is `ownerWalletInput`, else a wallet linked to the listing's account. Registrar mode: queue for the worker.
 */
export async function requestSubjectRegistration(ctx: Ctx, subject: Subject, ownerWalletInput?: string) {
  const registry = registryOrFail(ctx);
  if (!subject.active) {
    if (subject.kind === "host") fail(409, "Only a host admitted to the network (probation, shadow or live) can register an identity.", "host_not_admitted");
    fail(409, "Only a listed tool can register an identity.", "tool_not_listed");
  }
  const state = await ensureState(ctx, subject);
  if (state.status === "registered") fail(409, `This ${subject.kind} already has a registered identity.`, "identity_registered");
  if (state.status === "submitted") fail(409, "A registration transaction is already pending.", "identity_pending");
  const agentURI = registrationUrl(ctx, state.id);
  const mode = ctx.cfg.identity.mode;
  const open: SubjectStatus[] = ["none", "awaiting_owner", "queued", "failed"];
  if (mode === "registrar") {
    if (!await moveState(ctx.db, state, open, { status: "queued", mode, registry: registry.id, agentId: null, ownerAddress: null, error: null, txHash: null })) fail(409, "A registration transaction is already pending.", "identity_pending");
    return { status: "queued", mode, agent_uri: agentURI, registry: registry.id };
  }
  const owner = subject.kind === "host" ? subject.operator : ownerWalletInput ?? (subject.accountId ? (await accountWallets(ctx, subject.accountId))[0] : undefined);
  if (!owner) fail(409, "No wallet to own the identity: link a wallet to the listing's account (wallet sign-in), or send `owner_wallet` (a base58 Solana address) with the request.", "identity_owner_wallet_required");
  let prepared;
  try {
    prepared = await identityChain(ctx).prepareRegistration(owner, agentURI, receiptKeysUrl(ctx));
  } catch (e) {
    log.warn("identity registration not prepared", { error: (e as Error).message.slice(0, 160) });
    fail(503, "The agent registry could not be reached to prepare the transaction; try again shortly.", "identity_registry_unavailable");
  }
  // The asset keypair signed the transaction and is gone; its public key is the agent id this registration will have.
  if (!await moveState(ctx.db, state, open, { status: "awaiting_owner", mode, registry: registry.id, agentId: prepared.asset, ownerAddress: owner, error: null, txHash: null })) fail(409, "A registration transaction is already pending.", "identity_pending");
  return {
    status: "awaiting_owner", mode, agent_uri: agentURI, registry: registry.id, agent_id: prepared.asset,
    transaction: { network: ctx.cfg.chain.network, program_id: registry.programId, fee_payer: prepared.feePayer, transaction: prepared.transaction, expires_at_block_height: prepared.expiresAtBlockHeight, rent_sol: REGISTRATION_RENT_SOL, instructions: prepared.instructions },
    next: `Sign and send this transaction from the owner wallet before it expires, then POST its signature as tx_hash to ${paths(subject)}/confirm. An expired transaction is replaced by requesting again.`,
  };
}

/** Owner mode: read the owner's transaction and keep the agent id it registered for this subject's registration file. */
export async function confirmSubjectRegistration(ctx: Ctx, subject: Subject, signature: string) {
  registryOrFail(ctx);
  const state = await subjectState(ctx.db, subject.kind, subject.ref);
  if (!state || state.status !== "awaiting_owner") fail(409, `No owner registration is waiting for this ${subject.kind}; request one first.`, "identity_not_requested");
  const r = await identityChain(ctx).registration(signature);
  if (r.status === "pending") fail(409, "The transaction is not confirmed yet; try again shortly.", "identity_tx_pending");
  if (r.status === "failed") fail(422, r.reason === "reverted" ? "The transaction failed on chain." : "The transaction did not register an identity in the configured registry.", "identity_tx_invalid");
  if (r.agentURI !== registrationUrl(ctx, state.id)) fail(422, `The transaction registered a different agent URI than this ${subject.kind}'s registration file.`, "identity_uri_mismatch");
  // A host's identity belongs to its operator wallet and to no other.
  if (subject.kind === "host" && r.owner !== subject.operator) fail(422, "The transaction registered the identity to a wallet that is not this host's operator.", "identity_owner_mismatch");
  const patch = { status: "registered" as const, agentId: r.agentId, ownerAddress: r.owner, txHash: signature, error: null };
  if (!await moveState(ctx.db, state, ["awaiting_owner"], patch)) fail(409, `No owner registration is waiting for this ${subject.kind}; request one first.`, "identity_not_requested");
  return subjectIdentityJson(ctx, subject, { ...state, ...patch }, true);
}

/** The registrar worker's part for hosts and tools: confirm submitted registrations, then send queued ones. */
export async function runSubjectRegistrations(ctx: Ctx, chain: IdentityChain, limit = 10) {
  let sent = 0, confirmed = 0, failed = 0;
  const withStatus = async (status: SubjectStatus) =>
    (await ctx.db.select({ value: kv.value }).from(kv).where(and(like(kv.key, `${STATE_PREFIX}%`), sql`${kv.value}->>'status' = ${status}`)).limit(limit)).map(r => readState(r.value)).filter((s): s is SubjectState => !!s);
  for (const state of await withStatus("submitted")) {
    if (!state.txHash) continue;
    const r = await chain.registration(state.txHash);
    if (r.status === "pending") continue;
    if (r.status === "ok" && r.agentURI === registrationUrl(ctx, state.id)) {
      if (await moveState(ctx.db, state, ["submitted"], { status: "registered", agentId: r.agentId, ownerAddress: r.owner, error: null })) confirmed++;
      continue;
    }
    failed++;
    await moveState(ctx.db, state, ["submitted"], { status: "failed", error: r.status === "failed" ? r.reason : "uri_mismatch" });
  }
  for (const state of await withStatus("queued")) {
    // A host that is no longer admitted, or a tool that is no longer listed, waits: nothing is sent for it.
    if (!(await loadSubject(ctx, state.kind, state.ref))?.active) continue;
    try {
      const { signature, asset } = await chain.register(registrationUrl(ctx, state.id), receiptKeysUrl(ctx));
      await moveState(ctx.db, state, ["queued"], { status: "submitted", txHash: signature, agentId: asset, ownerAddress: ctx.cfg.identity.registrar ?? null });
      sent++;
    } catch (e) {
      failed++;
      log.warn("subject identity registration not sent", { error: (e as Error).name });
      await moveState(ctx.db, state, ["queued"], { status: "failed", error: "send_failed" });
    }
  }
  return { sent, confirmed, failed };
}

/**
 * Registration file (ERC-8004 registration-v1) of a host or a tool, for the same public URL agent keys use; null when
 * the id is not a subject's. A host that is no longer admitted, or a tool that is no longer listed, is `active: false`.
 */
export async function subjectRegistrationFile(ctx: Ctx, id: string) {
  if (!identityIdPattern.test(id)) return null;
  const [pointer] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, idKey(id)));
  const p = pointer?.value as { kind?: unknown; ref?: unknown } | undefined;
  if (!p || (p.kind !== "host" && p.kind !== "tool") || typeof p.ref !== "string") return null;
  const state = await subjectState(ctx.db, p.kind, p.ref);
  if (!state || state.id !== id) return null;
  const subject = await loadSubject(ctx, p.kind, p.ref);
  const services: { name: string; endpoint: string; version?: string }[] = [];
  let name = p.kind === "host" ? "Unlisted host" : "Unlisted tool", description = "";
  if (subject?.host) {
    name = subject.host.name;
    description = "A host on the Trellis network. Its admission state is at the trellis-host-status service.";
    services.push({ name: "web", endpoint: `${ctx.cfg.siteUrl}/hosts/?id=${encodeURIComponent(subject.ref)}` }, { name: "trellis-host-status", endpoint: `${ctx.cfg.publicUrl}/api/v1/network/hosts/${encodeURIComponent(subject.ref)}/status`, version: "1" });
  } else if (subject?.tool) {
    name = subject.tool.name;
    description = subject.tool.summary;
    services.push({ name: "trellis-tool", endpoint: `${ctx.cfg.publicUrl}/api/v1/tools/${subject.ref}`, version: "1" });
    // How it is called: the x402 resource itself, paid from a Trellis balance through the tool call route.
    if (subject.active) services.push({ name: "x402", endpoint: subject.tool.resource }, { name: "trellis-tool-call", endpoint: `${ctx.cfg.publicUrl}/api/v1/tools/call`, version: "1" });
  }
  services.push({ name: "trellis-receipt-keys", endpoint: receiptKeysUrl(ctx) });
  const registry = state.registry ?? ctx.cfg.identity.registry.id;
  return {
    type: REGISTRATION_TYPE,
    name,
    description,
    services,
    active: !!subject?.active,
    registrations: state.status === "registered" && state.agentId && registry ? [{ agentId: state.agentId, agentRegistry: registry }] : [],
    supportedTrust: ctx.cfg.identity.paidFeedback ? ["reputation"] : [],
    trellis: {
      kind: p.kind,
      notice: p.kind === "host"
        ? "A network host as this router records it. Trellis links its receipt keys; feedback about the host is accepted only with a receipt on which the reviewer paid for a call it served. This file does not verify the host's hardware or conduct."
        : "A tool listing as its seller wrote it. Trellis links its receipt keys; feedback about the tool is accepted only with a receipt on which the reviewer paid for a call to it. This file does not verify the tool's answers.",
    },
  };
}
