import { sql } from "drizzle-orm";
import { pgTable, text, bigint, boolean, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// Verifiable-inference tables (docs/Trellis_Backend.md §3 and §5.3): shadow re-executions and the evidence rows
// handed to the slasher. Hashes, ids, counts and fixed codes only; no prompt or answer bytes are written here.
// Money is pico-USD.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** One row per shadow re-execution the job attempted, including the ones that found no second host. */
export const shadowRuns = pgTable(
  "shadow_runs",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull(),
    modelId: text("model_id").notNull(),
    digest: text("digest").notNull(), // the model digest both hosts serve, or model:<id> when no measurement is recorded
    seed: integer("seed"),
    hostA: text("host_a").notNull(), // provider id that served the caller
    hostB: text("host_b"), // provider id that re-executed; null when none qualified
    status: text("status").notNull(), // match | mismatch | no_peer | failed | expired
    hashA: text("hash_a"), // sha256 of the answer the caller received (the receipt's response_sha256)
    hashB: text("hash_b"), // sha256 of the shadow answer
    cost: bigint("cost", { mode: "bigint" }).notNull().default(sql`0`), // pico-USD paid from treasury; never billed to the caller
    latencyMs: integer("latency_ms"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shadow_runs_generation_uq").on(t.generationId), index("shadow_runs_host_idx").on(t.hostA, t.createdAt)],
);

/** A mismatch: the same request, digest and seed answered differently by two attested hosts. */
export const shadowEvidence = pgTable(
  "shadow_evidence",
  {
    id: text("id").primaryKey(),
    generationId: text("generation_id").notNull(),
    hostA: text("host_a").notNull(),
    hostB: text("host_b").notNull(),
    digest: text("digest").notNull(),
    seed: integer("seed"),
    hashA: text("hash_a").notNull(),
    hashB: text("hash_b").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("shadow_evidence_generation_uq").on(t.generationId), index("shadow_evidence_host_idx").on(t.hostA, t.createdAt)],
);

/**
 * Evidence queue for the slasher (src/services/slasher.ts), one row per fault found by the shadow and canary-evidence
 * jobs. Hand-off: the slasher reads rows with status "pending", opens a proposal for (provider_id, reason) under the
 * §5.3 schedule carried in `bps` and `delist`, then sets status "proposed" with the proposal's `slash_id`; "dismissed"
 * closes a row without a proposal. The existing host_slash_evidence table was not reused: its reason is a numeric
 * contract code, its bundle format is closed to policy_rejection / invalid_receipt / makegood_refund, and it is gated
 * on NETWORK_BONDS_ENABLED, none of which fits §5.3's "shadow_mismatch" and "quantization_swap" rows.
 */
export const slashEvidence = pgTable(
  "slash_evidence",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id"),
    reason: text("reason").notNull(), // shadow_mismatch | quantization_swap
    bps: integer("bps").notNull(), // share of the bond the §5.3 table assigns
    delist: boolean("delist").notNull().default(false),
    evidenceRoot: text("evidence_root").notNull(), // Merkle root over the canonical evidence items (same shape as slashes.evidence_root)
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    windowFrom: ts("window_from").notNull(),
    windowTo: ts("window_to").notNull(),
    status: text("status").notNull().default("pending"), // pending | proposed | dismissed
    slashId: text("slash_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    pickedUpAt: ts("picked_up_at"),
  },
  (t) => [uniqueIndex("slash_evidence_root_uq").on(t.providerId, t.reason, t.evidenceRoot), index("slash_evidence_status_idx").on(t.status, t.createdAt)],
);
