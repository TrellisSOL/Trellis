import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Tables behind the $TRLS holder perks (src/solana/tiers.ts): the early-access window of a newly listed model, and the
// advisory holder polls with their votes. Nothing here holds money or grants any.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** One row per model that has (or had) an early-access window: holders may use it before `until`, by tier. */
export const modelEarlyAccess = pgTable("model_early_access", {
  modelId: text("model_id").primaryKey(),
  listedAt: ts("listed_at").notNull(),
  until: ts("until").notNull(),
  source: text("source").notNull(), // listing (set when the model was first listed) | operator (set by the admin route)
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type PollResults = { options: { option: string; votes: number; weight: number }[]; total_votes: number; total_weight: number };

/** An advisory poll for holders. Results never execute anything. */
export const holderPolls = pgTable(
  "holder_polls",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // model_listing (options are candidate model ids) | slash_schedule
    title: text("title").notNull(),
    options: text("options").array().notNull(),
    status: text("status").notNull().default("open"), // open | closed
    closesAt: ts("closes_at"), // voting is refused from this time on; the operator still closes the poll
    createdAt: ts("created_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    results: jsonb("results").$type<PollResults>(), // the final tally, written once at close
  },
  (t) => [index("holder_polls_status_idx").on(t.status, t.createdAt)],
);

/** One vote per poll per wallet. `weight` is the tier's fixed vote_weight when the vote was cast, never a balance. */
export const holderVotes = pgTable(
  "holder_votes",
  {
    pollId: text("poll_id").notNull().references(() => holderPolls.id, { onDelete: "cascade" }),
    wallet: text("wallet").notNull(),
    choice: text("choice").notNull(),
    tier: text("tier").notNull(),
    weight: integer("weight").notNull(),
    closingTier: text("closing_tier"), // the wallet's tier when the poll closed (null: none, or the poll is open)
    closingWeight: integer("closing_weight"), // the weight counted in the results (null while the poll is open)
    votedAt: ts("voted_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.wallet] })],
);
