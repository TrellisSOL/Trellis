import { sql } from "drizzle-orm";
import { pgTable, text, bigint, boolean, integer, real, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

// HVX (docs/Trellis_Backend.md §5.6): the hourly $/1M-token index per grade, built from receipts only. Money is pico-USD.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const hvxPoints = pgTable(
  "hvx_points",
  {
    grade: text("grade").notNull(), // G-S | G-M | G-L
    hour: ts("hour").notNull(), // start of the UTC hour
    usdPerMtoken: real("usd_per_mtoken"), // null when the hour had no qualifying receipt
    thin: boolean("thin").notNull().default(true),
    sampleCount: integer("sample_count").notNull().default(0), // receipts that passed the wash filter
    excludedCount: integer("excluded_count").notNull().default(0), // receipts the wash filter removed
    tokens: bigint("tokens", { mode: "bigint" }).notNull().default(sql`0`), // output-equivalent tokens of the sample
    volume: bigint("volume", { mode: "bigint" }).notNull().default(sql`0`), // pico-USD paid in the sample
    dailyVolume: bigint("daily_volume", { mode: "bigint" }).notNull().default(sql`0`), // pico-USD over the trailing 24 hours, same filter
    publishedTx: text("published_tx"), // HvxFeed transaction once published on-chain
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.grade, t.hour] }), index("hvx_points_hour_idx").on(t.hour)],
);
