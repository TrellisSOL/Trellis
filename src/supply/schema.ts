import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The warm pool's own record of what it deployed (src/supply/warm-pool.ts). One row per adapter and model. The endpoint
// itself lives in the provider registry (providers.base_url); nothing here is a credential.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const supplyDeployments = pgTable(
  "supply_deployments",
  {
    id: text("id").primaryKey(), // <adapter>:<model id>
    adapter: text("adapter").notNull(), // nosana | ionet
    modelId: text("model_id").notNull(),
    digest: text("digest").notNull(), // sha256:<hex> of the pinned weights the deployment was started with
    externalId: text("external_id"), // the GPU network's id for the deployment
    providerId: text("provider_id").notNull(), // registry id of the first endpoint; further ones add -r1, -r2...
    replicas: integer("replicas").notNull().default(0), // replicas the last plan asked for
    listedCount: integer("listed_count").notNull().default(0), // endpoints currently registered as providers
    listedStatus: text("listed_status"), // registry status the providers had when the pool took them out, to put back
    status: text("status").notNull(), // starting | running | stopped | failed
    lane: text("lane").notNull().default("open"), // open | attestable (an attestation URL was configured; the attestor decides)
    hourlyCost: bigint("hourly_cost", { mode: "bigint" }).notNull().default(sql`0`), // pico-USD per hour for all replicas, as quoted
    demandTokens: bigint("demand_tokens", { mode: "bigint" }).notNull().default(sql`0`), // output-equivalent tokens of the last hour behind the plan
    fault: text("fault"), // fixed code of the last failure: ensure_failed | unhealthy | teardown_failed
    startedAt: ts("started_at"),
    stoppedAt: ts("stopped_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("supply_deployments_status_idx").on(t.status)],
);
