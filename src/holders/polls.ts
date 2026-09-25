import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { uid } from "../lib/util.ts";
import { lookupHolder, tierRank } from "../solana/tiers.ts";
import { holderPolls, holderVotes, type PollResults } from "./schema.ts";

// Advisory holder polls. An operator opens a poll (which model to list next, or a slash schedule to adopt); a wallet
// that holds a tier votes once, signed with X-Wallet-Auth. A vote's weight is its tier's fixed `vote_weight` (1, 2,
// 3...): never the balance, so holding more inside a tier adds nothing. When the operator closes the poll every
// voter's balance is read again, and a wallet that has dropped below the tier it voted with counts with the weight of
// the tier it holds then (0 with none). Results are public and advisory: nothing here lists a model, changes a slash
// schedule or moves anything.

export const POLL_KINDS = ["model_listing", "slash_schedule"] as const;
export type PollKind = (typeof POLL_KINDS)[number];
export type PollRow = typeof holderPolls.$inferSelect;

const option = z.string().trim().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u, "must not contain control characters");
export const pollCreateSchema = z.strictObject({
  kind: z.enum(POLL_KINDS),
  title: z.string().trim().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u, "must not contain control characters"),
  // model_listing: candidate model ids ("author/model"); slash_schedule: the schedules on offer.
  options: z.array(option).min(2).max(20).refine((v) => new Set(v).size === v.length, "options must be distinct"),
  closes_at: z.iso.datetime({ offset: true }).optional(),
});
/** The vote body. It names the poll as well as the option, so the wallet's signature over the body cannot be replayed on another poll. */
export const voteSchema = z.strictObject({ poll_id: z.string().min(1).max(80), option });

export async function createPoll(ctx: Ctx, input: z.infer<typeof pollCreateSchema>): Promise<PollRow> {
  if (input.kind === "model_listing" && input.options.some((o) => !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(o)))
    fail(400, "A model_listing poll's options are candidate model ids like \"author/model\".", "invalid_request");
  const closesAt = input.closes_at ? new Date(input.closes_at) : null;
  if (closesAt && closesAt.getTime() <= Date.now()) fail(400, "`closes_at` must be in the future.", "invalid_request");
  const [row] = await ctx.db.insert(holderPolls).values({ id: uid("poll_"), kind: input.kind, title: input.title, options: input.options, closesAt }).returning();
  return row!;
}

export async function getPoll(ctx: Ctx, id: string): Promise<PollRow> {
  const [row] = /^poll_[A-Za-z0-9_-]{1,64}$/.test(id) ? await ctx.db.select().from(holderPolls).where(eq(holderPolls.id, id)) : [];
  if (!row) fail(404, "Poll not found.", "not_found");
  return row;
}

export const listPolls = (ctx: Ctx, status?: "open" | "closed") =>
  ctx.db.select().from(holderPolls).where(status ? eq(holderPolls.status, status) : undefined).orderBy(desc(holderPolls.createdAt), desc(holderPolls.id)).limit(100);

const tally = (options: string[], votes: { choice: string; weight: number }[]): PollResults => {
  const rows = options.map((o) => ({ option: o, votes: 0, weight: 0 }));
  for (const v of votes) {
    const r = rows.find((x) => x.option === v.choice);
    if (!r) continue;
    r.votes++;
    r.weight += v.weight;
  }
  return { options: rows, total_votes: rows.reduce((n, r) => n + r.votes, 0), total_weight: rows.reduce((n, r) => n + r.weight, 0) };
};

/** A poll as the public endpoints show it: the tally, never who voted. An open poll's tally uses vote-time weights. */
export async function pollJson(ctx: Ctx, p: PollRow) {
  const results = p.results ?? tally(p.options, await ctx.db.select({ choice: holderVotes.choice, weight: holderVotes.weight }).from(holderVotes).where(eq(holderVotes.pollId, p.id)));
  return {
    id: p.id,
    kind: p.kind as PollKind,
    title: p.title,
    options: p.options,
    status: p.status as "open" | "closed",
    created_at: p.createdAt.toISOString(),
    closes_at: p.closesAt?.toISOString() ?? null,
    closed_at: p.closedAt?.toISOString() ?? null,
    advisory: true as const,
    results: { ...results, final: p.status === "closed" },
  };
}

/** Cast `wallet`'s one vote in a poll. The wallet must hold a tier whose vote_weight is above 0 right now. */
export async function castVote(ctx: Ctx, pollId: string, wallet: string, choice: string) {
  const poll = await getPoll(ctx, pollId);
  if (poll.status !== "open" || (poll.closesAt && poll.closesAt.getTime() <= Date.now())) fail(409, "This poll is closed.", "poll_closed");
  if (!poll.options.includes(choice)) fail(400, "`option` must be one of the poll's options.", "invalid_request", { options: poll.options });
  if (!ctx.cfg.holders.enabled) fail(403, "Holder tiers are not enabled on this router.", "not_a_holder");
  const look = await lookupHolder(ctx, wallet);
  if (look.error) fail(503, "Your token balance could not be read. Try again.", "balance_unavailable");
  const tier = look.tier;
  if (!tier || tier.voteWeight <= 0) fail(403, "Voting needs a wallet that holds a tier with a vote.", "not_a_holder");
  const [row] = await ctx.db.insert(holderVotes).values({ pollId: poll.id, wallet, choice, tier: tier.name, weight: tier.voteWeight }).onConflictDoNothing().returning();
  if (!row) fail(409, "This wallet has already voted in this poll.", "already_voted");
  return { poll_id: poll.id, option: choice, tier: tier.name, weight: tier.voteWeight, voted_at: row.votedAt.toISOString() };
}

/**
 * Close a poll: read every voter's balance again (not from the hour's cache), re-weight the wallets that dropped below
 * the tier they voted with, and write the final tally. A balance that cannot be read stops the close with nothing
 * changed, so no vote is counted on a guess; the operator closes again. Closing a closed poll returns it as it is.
 */
export async function closePoll(ctx: Ctx, pollId: string): Promise<PollRow> {
  const poll = await getPoll(ctx, pollId);
  if (poll.status === "closed") return poll;
  // Voting stops first, so the votes read below are the votes counted.
  const stop = new Date();
  if (!poll.closesAt || poll.closesAt > stop) await ctx.db.update(holderPolls).set({ closesAt: stop }).where(and(eq(holderPolls.id, poll.id), eq(holderPolls.status, "open")));
  const votes = await ctx.db.select().from(holderVotes).where(eq(holderVotes.pollId, poll.id)).orderBy(asc(holderVotes.votedAt));
  const tiers = ctx.cfg.holders.tiers;
  const closing: { wallet: string; choice: string; closingTier: string | null; weight: number }[] = [];
  for (const v of votes) {
    const look = await lookupHolder(ctx, v.wallet, { fresh: true });
    if (look.error) fail(503, "A voter's token balance could not be read, so the poll was not closed. Try again.", "balance_unavailable");
    const now = ctx.cfg.holders.enabled ? look.tier : null;
    const then = tiers.find((t) => t.name === v.tier) ?? null;
    // Dropped below the tier voted with (or that tier no longer exists): the closing tier's weight. Otherwise the vote stands.
    const dropped = !then || tierRank(tiers, now) < tierRank(tiers, then);
    closing.push({ wallet: v.wallet, choice: v.choice, closingTier: now?.name ?? null, weight: dropped ? Math.min(v.weight, now?.voteWeight ?? 0) : v.weight });
  }
  const results = tally(poll.options, closing);
  return ctx.db.transaction(async (tx) => {
    for (const c of closing) await tx.update(holderVotes).set({ closingTier: c.closingTier, closingWeight: c.weight }).where(and(eq(holderVotes.pollId, poll.id), eq(holderVotes.wallet, c.wallet)));
    // A vote that slipped in after voting stopped was never re-checked, so it is not part of the poll.
    await tx.delete(holderVotes).where(and(eq(holderVotes.pollId, poll.id), isNull(holderVotes.closingWeight)));
    const [row] = await tx.update(holderPolls).set({ status: "closed", closedAt: new Date(), results }).where(and(eq(holderPolls.id, poll.id), eq(holderPolls.status, "open"))).returning();
    return row ?? (await tx.select().from(holderPolls).where(eq(holderPolls.id, poll.id)))[0]!;
  });
}
