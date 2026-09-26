import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Ctx } from "../context.ts";
import type { KeyRow } from "../api/auth.ts";
import { kv } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { agentFeedback } from "./schema.ts";
import { feedbackWeight, paidBand, type feedbackBody } from "./feedback.ts";
import { feedbackOnchain } from "./feedback-onchain.ts";
import { knownReceiptKind, lockReceipt, resolvePaidReceipt, subjectFeedbackReceiptKey } from "./receipt-sources.ts";
import { subjectState, type Subject, type SubjectKind } from "./subjects.ts";

// Paid feedback about a network host or a tool listing: no receipt, no feedback, by the same rules as feedback about an
// agent (src/identity/feedback.ts). The receipt must be one the reviewer's account paid, and it must have paid this
// host (a model call it served) or this tool (a call to this listing). agent_feedback is keyed by an agent key, so the
// entries live in the generic kv table, one row per receipt:
//   identity:subject-feedback:<receipt kind>:<receipt id>   SubjectFeedback (the reviewer's account stays in this row)
//   identity:subject-feedback-id:<entry id>                 { receipt: <the key above> }: resolves the public entry URL

export type SubjectFeedback = {
  v: 1;
  /** sf_<24 hex> */
  id: string;
  subject: { kind: SubjectKind; ref: string };
  reviewerAccountId: string;
  receiptKind: string;
  receiptId: string;
  score: number;
  tag1: string | null;
  tag2: string | null;
  /** pico-USD, as a decimal string (jsonb holds no bigint). */
  paidPico: string;
  paidAt: string;
  createdAt: string;
};

export const subjectFeedbackIdPattern = /^sf_[0-9a-f]{24}$/;
const entryKey = (id: string) => `identity:subject-feedback-id:${id}`;
/** The receipt kind that pays each kind of subject. */
const RECEIPT_KIND: Record<SubjectKind, string> = { host: "model.call", tool: "tool.call" };

export const subjectFeedbackUrl = (ctx: Ctx, id: string) => `${ctx.cfg.publicUrl}/api/v1/agents/feedback/${id}`;

/** The public fields of an entry: no reviewer, no receipt id, a coarse band instead of the amount. */
const publicEntry = (f: SubjectFeedback) => ({ id: f.id, subject: { kind: f.subject.kind, id: f.subject.ref }, score: f.score, tag1: f.tag1, tag2: f.tag2, receipt_kind: f.receiptKind, paid_band: paidBand(BigInt(f.paidPico)), paid_day: f.paidAt.slice(0, 10), created_at: f.createdAt });
/** The entry as served at its feedback URI: this document's hash is what an on-chain entry commits to. */
const feedbackDocument = (f: SubjectFeedback, receiptHash: string | null) => ({ ...publicEntry(f), receipt_hash: receiptHash });

function readEntry(value: unknown): SubjectFeedback | null {
  const f = value as Partial<SubjectFeedback> | null;
  if (!f || typeof f !== "object" || f.v !== 1 || typeof f.id !== "string" || !subjectFeedbackIdPattern.test(f.id)) return null;
  if (typeof f.receiptKind !== "string" || typeof f.receiptId !== "string" || typeof f.paidPico !== "string" || !/^\d+$/.test(f.paidPico) || typeof f.paidAt !== "string") return null;
  return f as SubjectFeedback;
}

/**
 * Record one entry about a host or a tool. The reviewer's account must be the receipt's payer; the receipt must have
 * paid this subject, above zero; nobody reviews a host or a tool their own account controls; one entry per receipt,
 * across agents, hosts and tools. Returns the entry and the receipt's hash, the evidence an on-chain entry commits to.
 */
export async function submitSubjectFeedback(ctx: Ctx, reviewer: KeyRow, subject: Subject, input: z.infer<typeof feedbackBody>) {
  if (input.receipt_kind && !knownReceiptKind(input.receipt_kind)) fail(422, "Unknown receipt kind.", "receipt_kind_unknown");
  if (subject.accountId && reviewer.accountId === subject.accountId) fail(403, `An account cannot give feedback to a ${subject.kind} it controls.`, "self_feedback");
  const receipt = await resolvePaidReceipt(ctx, input.receipt_id, input.receipt_kind);
  if (!receipt) fail(422, "Feedback needs a paid receipt this router recorded; none was found for that id.", "receipt_required");
  if (!receipt.payerAccountId) fail(422, "This receipt names no payer (unlinkable or blind payment), so it cannot back feedback.", "receipt_unlinkable");
  if (receipt.payerAccountId !== reviewer.accountId) fail(403, "Only the payer on a receipt can use it for feedback.", "not_receipt_payer");
  if (receipt.payee.accountIds.includes(reviewer.accountId)) fail(403, "An account cannot give feedback on a payment to itself.", "self_feedback");
  if (receipt.kind !== RECEIPT_KIND[subject.kind] || receipt.subject?.kind !== subject.kind || receipt.subject.ref !== subject.ref) fail(403, `This receipt did not pay this ${subject.kind}.`, "receipt_subject_mismatch");
  if (receipt.paidPico <= 0n) fail(422, "Feedback needs a receipt with a payment above zero.", "receipt_unpaid");
  const now = new Date();
  const entry: SubjectFeedback = { v: 1, id: uid("sf_"), subject: { kind: subject.kind, ref: subject.ref }, reviewerAccountId: reviewer.accountId, receiptKind: receipt.kind, receiptId: receipt.id, score: input.score, tag1: input.tag1 ?? null, tag2: input.tag2 ?? null, paidPico: receipt.paidPico.toString(), paidAt: receipt.at.toISOString(), createdAt: now.toISOString() };
  const key = subjectFeedbackReceiptKey(receipt.kind, receipt.id);
  const stored = await ctx.db.transaction(async tx => {
    await lockReceipt(tx, receipt.kind, receipt.id);
    const [agentEntry] = await tx.select({ id: agentFeedback.id }).from(agentFeedback).where(and(eq(agentFeedback.receiptKind, receipt.kind), eq(agentFeedback.receiptId, receipt.id))).limit(1);
    if (agentEntry) return false;
    const [row] = await tx.insert(kv).values({ key, value: entry }).onConflictDoNothing().returning({ key: kv.key });
    if (!row) return false;
    await tx.insert(kv).values({ key: entryKey(entry.id), value: { receipt: key } });
    return true;
  });
  if (!stored) fail(409, "This receipt already backs a feedback entry.", "receipt_already_used");
  return { entry, receiptHash: receipt.hash };
}

/** The public entry behind a feedback URI; null when the id is unknown. */
export async function subjectFeedbackDocument(ctx: Ctx, id: string) {
  if (!subjectFeedbackIdPattern.test(id)) return null;
  const [pointer] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, entryKey(id)));
  const key = (pointer?.value as { receipt?: unknown } | undefined)?.receipt;
  if (typeof key !== "string") return null;
  const [row] = await ctx.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
  const entry = row ? readEntry(row.value) : null;
  if (!entry || entry.id !== id) return null;
  return feedbackDocument(entry, (await resolvePaidReceipt(ctx, entry.receiptId, entry.receiptKind))?.hash ?? null);
}

/**
 * The feedback routes' answer: the public entry, its weight now and, when the subject has a registered identity, the
 * optional give_feedback transaction for the reviewer's own wallet (only with a receipt hash; see feedbackOnchain).
 */
export async function giveSubjectFeedback(ctx: Ctx, reviewer: KeyRow, subject: Subject, input: z.infer<typeof feedbackBody>) {
  const { entry, receiptHash } = await submitSubjectFeedback(ctx, reviewer, subject, input);
  const document = feedbackDocument(entry, receiptHash), paidPico = BigInt(entry.paidPico);
  const state = await subjectState(ctx.db, subject.kind, subject.ref);
  const erc8004 = state?.status === "registered" && state.agentId
    ? await feedbackOnchain(ctx, { reviewerKeyHash: reviewer.keyHash, registry: state.registry, agentId: state.agentId, entry: document, feedbackURI: subjectFeedbackUrl(ctx, entry.id), receiptHash, paidPico, score: entry.score, tag1: entry.tag1, tag2: entry.tag2 })
    : null;
  return { ...document, weight_usd_now: Math.round(feedbackWeight(paidPico, new Date(entry.paidAt), new Date(), ctx.cfg.identity.halfLifeDays) * 1e6) / 1e6, erc8004 };
}
