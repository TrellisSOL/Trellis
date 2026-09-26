import type { Context, Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { keys } from "../db/schema.ts";
import { agentProfiles } from "../agents/profile-schema.ts";
import { profileSlug } from "../agents/profiles.ts";
import { isTrackRecord, verifyTrackRecord, type TrackRecordCertificate } from "../agents/track-record-shared.ts";
import { ownedKey, principal } from "../api/agents.ts";
import { requireKey, walletAuth } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { fail } from "../lib/errors.ts";
import { agentFeedback } from "./schema.ts";
import { reputationSummary } from "./card.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { isWalletAddress, isWalletSignature, WALLET_ADDRESS_RE } from "../lib/wallet-sig.ts";
import { SIGNATURE_RE } from "../solana/constants.ts";
import { feedbackBody, feedbackReceiptHash, feedbackWeight, paidBand, revokeFeedback, submitFeedback, type FeedbackRow } from "./feedback.ts";
import { feedbackOnchain } from "./feedback-onchain.ts";
import { confirmRegistration, identityIdPattern, identityRow, identitySettingsJson, registrationFile, requestRegistration, updateIdentitySettings } from "./identity.ts";
import { giveSubjectFeedback, subjectFeedbackDocument, subjectFeedbackIdPattern } from "./subject-feedback.ts";
import { confirmSubjectRegistration, hostConfirmBody, hostRegisterBody, hostSubject, requestSubjectRegistration, subjectIdentityJson, subjectRegistrationFile, subjectState } from "./subjects.ts";
import { issueTrackRecord, trackRecordById, trackRecordProof, validationEntry } from "./track-record.ts";
import { receiptKinds } from "./receipt-sources.ts";

// v6 I routes. Registered before the rulebook routes, so they answer by their own flags:
//   owner (owner/admin key, not a session key):
//   GET|PUT /api/v1/agents/:key_hash/identity            identity opt-out and reputation opt-in; registration progress
//   POST    /api/v1/agents/:key_hash/identity/register   owner mode: the registration transaction for the owner's wallet; registrar mode: queue
//   POST    /api/v1/agents/:key_hash/identity/confirm    owner mode: read the owner's transaction by its signature
//   POST    /api/v1/agents/:key_hash/track-record        issue a signed track record (optionally shown on the card)
//   public:
//   GET     /api/v1/agents/identity/:id/registration.json   the registration file (ERC-8004 registration-v1) of an agent key,
//                                                           a network host or a tool listing
//   GET     /api/v1/agents/track-records/:id                certificate and its validation entry (hashes of payload and certificate)
//   GET     /api/v1/agents/track-records/:id/proof?index=   one counted receipt's Merkle and anchor proofs
//   POST    /api/v1/agents/track-records/verify             check a certificate against the published keys
//   GET     /api/v1/agents/:slug/reputation                 paid-feedback reputation (PAID_FEEDBACK_ENABLED)
//   GET     /api/v1/agents/feedback/:id                     one public feedback entry (the registry's feedback_uri), about an
//                                                           agent (fb_) or about a host or a tool (sf_)
//   reviewer (any key of the paying account):
//   POST    /api/v1/agents/:slug/feedback                   needs a receipt the reviewer paid to this agent
//   DELETE  /api/v1/agents/:slug/feedback/:id               withdraw one's own entry
//   network hosts, only with NETWORK_HOSTS_ENABLED like every other host route (the same registry; tool listings have
//   the same three routes and the feedback route in src/tools/routes.ts):
//   GET     /api/v1/network/hosts/:providerId/identity           public: registration status, registry, agent id, registration URL
//   POST    /api/v1/network/hosts/:providerId/identity/register  operator wallet (X-Wallet-Auth over { provider_id }): the
//                                                                registration transaction for that wallet; registrar mode: queue
//   POST    /api/v1/network/hosts/:providerId/identity/confirm   operator wallet (X-Wallet-Auth over { provider_id, tx_hash })
//   POST    /api/v1/network/hosts/:providerId/feedback           reviewer key: needs a receipt the reviewer paid for a call this host served

const settingsBody = z.strictObject({ identity_opt_out: z.boolean().optional(), reputation_opt_in: z.boolean().optional() });
const registerBody = z.strictObject({ owner_wallet: z.string().regex(WALLET_ADDRESS_RE).refine(isWalletAddress, "expected a base58 Solana address (32 bytes)").optional() });
const confirmBody = z.strictObject({ tx_hash: z.string().regex(SIGNATURE_RE, "tx_hash must be a base58 transaction signature").refine(isWalletSignature, "tx_hash must be a base58 64-byte transaction signature") });
const trackRecordBody = z.strictObject({ publish: z.boolean().default(false) });
const feedbackIdPattern = /^fb_[0-9a-f]{24}$/;

/**
 * A JSON body signed by a wallet, as the host routes in src/api/network-hosts.ts read it: X-Wallet-Auth over
 * sha256(canonicalJson(body)), at most 8 KiB, and a per-wallet limit once the signature is verified. The limit is this
 * module's own family (host-identity-wallet:), so registering an identity never spends the wallet's signup budget.
 */
async function walletSignedBody(c: Context, ctx: Ctx) {
  const header = c.req.header("x-wallet-auth");
  if (!header) fail(401, "X-Wallet-Auth is required.", "invalid_wallet_auth");
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail(400, "JSON body required.", "invalid_json");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); fail(413, "Host body exceeds 8 KiB.", "payload_too_large"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail(400, "Request body must be valid JSON.", "invalid_json"); }
  const auth = await walletAuth(ctx, header, sha256(canonicalJson(body)), c);
  // Three a minute per wallet, apart from host signup and credential updates (network-host-wallet:).
  const limit = await ctx.limiter.take(`host-identity-wallet:${auth.wallet}`, 1, 3, 60_000);
  if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many host requests for this wallet.", "rate_limited"); }
  return { wallet: auth.wallet, body };
}

export function identityRoutes(app: Hono, ctx: Ctx) {
  const id = ctx.cfg.identity;
  const identityOn = () => { if (!id.enabled) fail(404, "Not found.", "not_found"); };
  const feedbackOn = () => { if (!id.paidFeedback) fail(404, "Not found.", "not_found"); };
  const eitherOn = () => { if (!id.enabled && !id.paidFeedback) fail(404, "Not found.", "not_found"); };
  // Host identity and host feedback exist only where the host network does (src/api/network-hosts.ts registers nothing without it).
  const hostsOn = () => { if (!ctx.cfg.networkHosts.enabled) fail(404, "Not found.", "not_found"); };
  const live = and(eq(keys.disabled, false), sql`(${keys.expiresAt} is null or ${keys.expiresAt} > now())`);
  const listed = async (slug: string) => {
    if (!profileSlug.safeParse(slug).success) fail(404, "Profile not found.", "not_found");
    const [row] = await ctx.db.select({ slug: agentProfiles.slug, keyHash: agentProfiles.keyHash, accountId: keys.accountId }).from(agentProfiles).innerJoin(keys, eq(keys.keyHash, agentProfiles.keyHash)).where(and(eq(agentProfiles.slug, slug), live));
    if (!row) fail(404, "Profile not found.", "not_found");
    return row;
  };
  const owned = async (c: Context) => ownedKey(ctx, await principal(ctx, c), c.req.param("key_hash")!);
  const publicEntry = (f: FeedbackRow, slug: string) => ({ id: f.id, agent: slug, score: f.score, tag1: f.tag1, tag2: f.tag2, receipt_kind: f.receiptKind, paid_band: paidBand(f.paidPico), paid_day: f.paidAt.toISOString().slice(0, 10), created_at: f.createdAt.toISOString() });
  // The entry as served at its feedback URI: the public fields plus the hash of the paid receipt behind it. This document's
  // hash is what an on-chain entry commits to (feedback_file_hash), next to the paid amount (value).
  const feedbackDocument = (f: FeedbackRow, slug: string, receiptHash: string | null) => ({ ...publicEntry(f, slug), receipt_hash: receiptHash });

  // ---- owner -------------------------------------------------------------------------------------------------------
  app.get("/api/v1/agents/:key_hash/identity", async c => {
    eitherOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    return c.json({ data: await identitySettingsJson(ctx, key.keyHash) });
  });
  app.put("/api/v1/agents/:key_hash/identity", async c => {
    eitherOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    return c.json({ data: await updateIdentitySettings(ctx, key.keyHash, settingsBody.parse(await readJson(c))) });
  });
  app.post("/api/v1/agents/:key_hash/identity/register", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(409, "Only active keys can register an identity.", "invalid_request");
    const { owner_wallet } = registerBody.parse(await readJson(c));
    return c.json({ data: await requestRegistration(ctx, key.keyHash, owner_wallet) });
  });
  app.post("/api/v1/agents/:key_hash/identity/confirm", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    const { tx_hash } = confirmBody.parse(await readJson(c));
    return c.json({ data: await confirmRegistration(ctx, key.keyHash, tx_hash) });
  });
  app.post("/api/v1/agents/:key_hash/track-record", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const key = await owned(c);
    if (key.disabled || (key.expiresAt && key.expiresAt <= new Date())) fail(409, "Only active keys can request a track record.", "invalid_request");
    const { publish } = trackRecordBody.parse(await readJson(c));
    return c.json({ data: await issueTrackRecord(ctx, key, publish) });
  });

  // ---- public identity and track records ---------------------------------------------------------------------------
  app.get("/api/v1/agents/identity/:id/registration.json", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const file = identityIdPattern.test(c.req.param("id")) ? await registrationFile(ctx, c.req.param("id")) ?? await subjectRegistrationFile(ctx, c.req.param("id")) : null;
    if (!file) fail(404, "Registration not found.", "not_found");
    return c.json(file);
  });
  app.post("/api/v1/agents/track-records/verify", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const body = await readJson(c);
    if (!isTrackRecord(body)) fail(400, "Malformed track record.", "invalid_request");
    return c.json({ data: { valid: verifyTrackRecord(body, { keys: await ctx.signer.jwks() }), notice: (body as TrackRecordCertificate).payload.notice } });
  });
  app.get("/api/v1/agents/track-records/:id", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const row = await trackRecordById(ctx, c.req.param("id"));
    if (!row) fail(404, "Track record not found.", "not_found");
    const certificate = row.certificate as TrackRecordCertificate;
    return c.json({ data: { id: row.id, certificate, valid: verifyTrackRecord(certificate, { keys: await ctx.signer.jwks() }), validation: validationEntry(ctx, row.id, certificate) } });
  });
  app.get("/api/v1/agents/track-records/:id/proof", async c => {
    identityOn(); c.header("cache-control", "no-store");
    const row = await trackRecordById(ctx, c.req.param("id"));
    if (!row) fail(404, "Track record not found.", "not_found");
    const index = z.coerce.number().int().min(0).max(1_000_000).parse(c.req.query("index") ?? "0");
    return c.json({ data: await trackRecordProof(ctx, row, index) });
  });

  // ---- paid feedback -----------------------------------------------------------------------------------------------
  app.get("/api/v1/agents/feedback/:id", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    if (subjectFeedbackIdPattern.test(c.req.param("id"))) {
      const document = await subjectFeedbackDocument(ctx, c.req.param("id"));
      if (!document) fail(404, "Feedback not found.", "not_found");
      return c.json(document);
    }
    if (!feedbackIdPattern.test(c.req.param("id"))) fail(404, "Feedback not found.", "not_found");
    const [f] = await ctx.db.select({ f: agentFeedback, slug: agentProfiles.slug }).from(agentFeedback).innerJoin(agentProfiles, eq(agentProfiles.keyHash, agentFeedback.subjectKeyHash)).innerJoin(keys, eq(keys.keyHash, agentFeedback.subjectKeyHash))
      .where(and(eq(agentFeedback.id, c.req.param("id")), sql`${agentFeedback.revokedAt} is null`, live));
    if (!f || !(await identityRow(ctx, f.f.subjectKeyHash))?.reputationOptIn) fail(404, "Feedback not found.", "not_found");
    return c.json(feedbackDocument(f.f, f.slug, await feedbackReceiptHash(ctx, f.f)));
  });
  app.get("/api/v1/agents/:slug/reputation", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const subject = await listed(c.req.param("slug"));
    const { summary, rows } = await reputationSummary(ctx, subject.keyHash, subject.slug);
    const identity = await identityRow(ctx, subject.keyHash);
    return c.json({ data: { agent: subject.slug, ...summary, receipt_kinds: receiptKinds(),
      recent: rows.slice(0, 20).map(f => publicEntry(f, subject.slug)),
      erc8004: identity?.status === "registered" && identity.reputationOptIn ? { registry: identity.registry, agent_id: identity.agentId, program_id: id.registry.programId ?? null } : null,
      notice: "Every entry is backed by a receipt on which the reviewer paid this agent through Trellis. Entries weigh what was paid, halving every half_life_days after the payment. Reviewers are not shown." } });
  });
  app.post("/api/v1/agents/:slug/feedback", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const limit = await ctx.limiter.take(`agent-feedback:${reviewer.accountId}`, 1, 30, 60_000);
    if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many feedback requests.", "rate_limited"); }
    const subject = await listed(c.req.param("slug"));
    if (!(await identityRow(ctx, subject.keyHash))?.reputationOptIn) fail(409, "This agent has not opted in to reputation.", "reputation_not_enabled");
    const input = feedbackBody.parse(await readJson(c));
    const { row, receiptHash } = await submitFeedback(ctx, reviewer, subject, input);
    const identity = await identityRow(ctx, subject.keyHash);
    const entry = feedbackDocument(row, subject.slug, receiptHash), feedbackURI = `${ctx.cfg.publicUrl}/api/v1/agents/feedback/${row.id}`;
    // A registered agent's entry also comes as a give_feedback transaction for the reviewer's own wallet, only with the
    // paid evidence of a signed receipt (feedbackOnchain). Optional.
    const onchain = identity?.status === "registered" && identity.agentId
      ? await feedbackOnchain(ctx, { reviewerKeyHash: reviewer.keyHash, registry: identity.registry, agentId: identity.agentId, entry, feedbackURI, receiptHash, paidPico: row.paidPico, score: row.score, tag1: row.tag1, tag2: row.tag2 })
      : null;
    return c.json({ data: { ...entry, weight_usd_now: Math.round(feedbackWeight(row.paidPico, row.paidAt, new Date(), id.halfLifeDays) * 1e6) / 1e6, erc8004: onchain } }, 201);
  });
  app.delete("/api/v1/agents/:slug/feedback/:id", async c => {
    feedbackOn(); c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const subject = await listed(c.req.param("slug"));
    if (!feedbackIdPattern.test(c.req.param("id"))) fail(404, "Feedback not found.", "not_found");
    await revokeFeedback(ctx, reviewer, subject.keyHash, c.req.param("id"));
    return c.json({ data: { revoked: true } });
  });

  // ---- network hosts -----------------------------------------------------------------------------------------------
  // The operator wallet signs the body, which names the host; any other wallet is told the host does not exist.
  const operatedHost = async <T extends { provider_id: string }>(c: Context, schema: z.ZodType<T>) => {
    const { wallet, body } = await walletSignedBody(c, ctx);
    const spec = schema.parse(body);
    if (spec.provider_id !== c.req.param("providerId")) fail(400, "Signed provider ID must match the identity path.", "invalid_request");
    const subject = await hostSubject(ctx, spec.provider_id);
    if (!subject || subject.operator !== wallet) fail(404, "Network host not found for this wallet.", "not_found");
    return { subject, spec };
  };
  app.get("/api/v1/network/hosts/:providerId/identity", async c => {
    hostsOn(); identityOn(); c.header("cache-control", "no-store");
    const subject = await hostSubject(ctx, c.req.param("providerId"));
    if (!subject) fail(404, "Network host not found.", "not_found");
    return c.json({ data: subjectIdentityJson(ctx, subject, await subjectState(ctx.db, "host", subject.ref)) });
  });
  app.post("/api/v1/network/hosts/:providerId/identity/register", async c => {
    hostsOn(); identityOn(); c.header("cache-control", "no-store");
    const { subject } = await operatedHost(c, hostRegisterBody);
    return c.json({ data: await requestSubjectRegistration(ctx, subject) });
  });
  app.post("/api/v1/network/hosts/:providerId/identity/confirm", async c => {
    hostsOn(); identityOn(); c.header("cache-control", "no-store");
    const { subject, spec } = await operatedHost(c, hostConfirmBody);
    return c.json({ data: await confirmSubjectRegistration(ctx, subject, spec.tx_hash) });
  });
  app.post("/api/v1/network/hosts/:providerId/feedback", async c => {
    hostsOn(); feedbackOn(); c.header("cache-control", "no-store");
    const reviewer = await requireKey(ctx, c.req.header("authorization"));
    const limit = await ctx.limiter.take(`agent-feedback:${reviewer.accountId}`, 1, 30, 60_000);
    if (!limit.ok) { c.header("retry-after", String(Math.ceil(limit.retryAfterMs / 1000))); fail(429, "Too many feedback requests.", "rate_limited"); }
    const subject = await hostSubject(ctx, c.req.param("providerId"));
    if (!subject) fail(404, "Network host not found.", "not_found");
    return c.json({ data: await giveSubjectFeedback(ctx, reviewer, subject, feedbackBody.parse(await readJson(c))) }, 201);
  });
}
