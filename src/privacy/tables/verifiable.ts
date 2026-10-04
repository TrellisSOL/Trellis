import type { ExternalDoc, RedisFamily, TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, KEPT_APPEND, rv } from "./common.ts";

// Verifiable inference (src/services/shadow.ts, src/services/canary-evidence.ts) and the HVX index (src/services/hvx.ts).

const ev = (file: string, contains: string) => ({ file, contains });
const HOST = (what: string) => ({ purpose: what, review: rv(["name:network"], "public-reference", "A provider id from the registry (the host's catalogue entry), not a network endpoint and not a caller's address.") });

export const verifiableTables: Record<string, TableDoc> = {
  shadow_runs: {
    category: "providers",
    purpose: "One row per shadow re-execution attempted: a sampled attested-lane call sent once more to a different attested host serving the same model digest, and whether the two answers hashed the same. Disabled unless SHADOW_ENABLED.",
    request: "yes",
    retention: KEPT_APPEND,
    columns: {
      id: "Shadow run id.",
      generation_id: "The sampled generation (its receipt id). Unique: a generation is re-executed at most once.",
      model_id: "Catalogue model id of the call.",
      digest: "The model digest both hosts serve (from their verified measurements), or model: and the model id when no measurement is recorded.",
      seed: "The sampling seed the request carried, when it carried one; the same seed is sent to the second host.",
      host_a: HOST("Provider that served the caller."),
      host_b: HOST("Provider that re-executed the request; empty when no other attested host served the digest."),
      status: "match, mismatch, no_peer (no second host), failed (the second host did not answer) or expired (the sealed request had already left the queue).",
      hash_a: "SHA-256 of the answer text the caller received, copied from the receipt.",
      hash_b: "SHA-256 of the second host's answer text; the answer itself is hashed in memory and dropped.",
      cost: "What the second call cost at the host's list price, in pico-USD, paid from treasury and never billed to the caller.",
      latency_ms: "Round-trip time of the second call.",
      created_at: CREATED,
    },
  },
  shadow_evidence: {
    category: "providers",
    purpose: "A shadow re-execution whose two answers differed: the same request, model digest and seed on two attested hosts. Each row also produces a slash_evidence row for the slasher.",
    request: "yes",
    retention: KEPT_APPEND,
    columns: {
      id: "Evidence id.",
      generation_id: "The sampled generation (its receipt id). Unique.",
      host_a: HOST("Provider that served the caller."),
      host_b: HOST("Provider that re-executed the request."),
      digest: "The model digest both hosts serve.",
      seed: "The sampling seed the request carried, when it carried one.",
      hash_a: "SHA-256 of the caller's answer text, from the receipt.",
      hash_b: "SHA-256 of the second host's answer text.",
      created_at: CREATED,
    },
  },
  slash_evidence: {
    category: "chain",
    purpose: "Evidence queued for the slasher under the bond schedule: a shadow re-execution mismatch (shadow_mismatch) or three consecutive failed quantisation canaries within a day (quantization_swap). The slasher turns a pending row into a proposal with its dispute window.",
    request: "aggregate",
    retention: KEPT + " Rows change status once, from pending to proposed or dismissed.",
    columns: {
      id: "Evidence id.",
      provider_id: "Provider the evidence is against.",
      model_id: "Catalogue model id the evidence concerns, when it concerns one model.",
      reason: "Fixed code: shadow_mismatch or quantization_swap.",
      bps: "Share of the bond the schedule assigns, in basis points (5,000 for a shadow mismatch, 2,500 for a quantisation swap).",
      delist: "Whether the schedule also removes the provider from the catalogue.",
      evidence_root: "Merkle root over the canonical evidence items, in the form the slashes table uses; unique with the provider and reason, so the same facts are queued once.",
      evidence: { purpose: "The evidence items and their time window: generation ids, provider ids, digests, seeds, SHA-256 hashes, canary timestamps, precision guesses and distances.", review: JSON_FIELDS("Written only by the shadow and canary-evidence jobs from ids, hashes, fixed codes and numbers; never request or answer text, headers or caller addresses.") },
      window_from: "Start of the time window the evidence covers.",
      window_to: "End of the time window the evidence covers.",
      status: "pending until the slasher reads it, then proposed (with slash_id) or dismissed.",
      slash_id: "The slashes row the slasher opened from this evidence.",
      created_at: CREATED,
      picked_up_at: "When the slasher read the row.",
    },
  },
  hvx_points: {
    category: "receipts",
    purpose: "The HVX index: one point per grade (G-S, G-M, G-L by model parameter count) and hour, the price in USD per million output-equivalent tokens paid in that hour's receipts after the wash filter. A public statistic; nothing settles against it. Computed only when HVX_ENABLED.",
    request: "aggregate",
    retention: KEPT + " A point is recomputed while its hour is within the look-back window and then left alone.",
    columns: {
      grade: "G-S, G-M or G-L.",
      hour: "Start of the UTC hour the point covers.",
      usd_per_mtoken: "USD paid per million output-equivalent tokens in the filtered sample; empty when the hour had no qualifying receipt.",
      thin: "Whether the grade's filtered volume over the trailing 24 hours was under HVX_THIN_DAILY_USD (50,000 USD unless changed).",
      sample_count: "Receipts that passed the wash filter.",
      excluded_count: "Receipts the wash filter removed: self-dealing, circular within two hops, below the minimum payment, or a model without a parameter count.",
      tokens: "Output-equivalent tokens in the sample (output and reasoning 1, prompt 0.25, cached prompt 0.05).",
      volume: "Pico-USD paid in the sample.",
      daily_volume: "Pico-USD over the trailing 24 points of the grade.",
      published_tx: "Transaction that published the point to the HvxFeed account, once published.",
      created_at: CREATED,
      updated_at: "When the point was last recomputed.",
    },
  },
};

/** The two Redis keys of shadow re-execution: the sealed request for a few minutes, and the queue of ids. */
export const shadowRedisFamilies: RedisFamily[] = [
  {
    key: "shadow:req:<generation id>",
    purpose:
      "Shadow re-execution (SHADOW_ENABLED, off by default). A sampled attested-lane request, as it went upstream, kept so the shadow job can send it once more to a different attested host and compare the two answers' hashes. For as long as it lives this is a place request text is kept: sealed with AES-256-GCM under a key derived from the router's APP_SECRET and the generation id, never in the database. The key names the generation, nothing else.",
    holds: "nothing-personal",
    requestText: "request-text",
    ttl: "SHADOW_REQUEST_TTL_S (300 seconds unless the operator changed it; 1,800 at most), set when the request is written. The shadow job takes it out with GETDEL, so it is gone the moment it is read; the job zeroes its own copy after the call and records hashes only.",
    evidence: [
      ev("src/services/shadow.ts", "await this.redis.set(`shadow:req:${id}`, sealed, \"PX\", ttlMs, \"NX\");"),
      ev("src/services/shadow.ts", "return this.redis.getdel(`shadow:req:${id}`);"),
      ev("src/services/shadow.ts", "for (const k of Object.keys(parked.body)) delete parked.body[k];"),
      ev("src/services/shadow-config.ts", "SHADOW_REQUEST_TTL_S: z.coerce.number().int().min(30).max(1_800).default(300)"),
    ],
  },
  {
    key: "shadow:queue",
    purpose: "The ids of sampled generations waiting for the shadow job, in order. Generation ids only; the request lives under shadow:req:<generation id>.",
    holds: "nothing-personal",
    ttl: "Until the shadow job pops it (every SHADOW_INTERVAL_MS, 15 seconds unless changed, up to SHADOW_BATCH ids per run). An id whose request has already expired is popped and recorded as expired.",
    evidence: [ev("src/services/shadow.ts", "await this.redis.rpush(\"shadow:queue\", id);"), ev("src/services/shadow.ts", "return (await this.redis.lpop(\"shadow:queue\", max)) ?? [];")],
  },
];

export const verifiableStores: ExternalDoc["otherStores"] = [
  {
    id: "shadow-memory",
    name: "Shadow re-execution queue in memory",
    purpose: "Without Redis, the same sealed request and queue as the Redis keys shadow:req:<generation id> and shadow:queue, in the router's memory, so a single-process deployment can re-execute a sample too.",
    holds: "The sealed request bytes of each sampled generation and the ids waiting; the bytes are overwritten with zeros when taken or when they expire.",
    ttl: "SHADOW_REQUEST_TTL_S (300 seconds unless changed); taken out once by the shadow job and zeroed. Lost when the router exits.",
    requestText: "request-text",
    evidence: [ev("src/services/shadow.ts", "export class MemoryShadowStore implements ShadowStore"), ev("src/services/shadow.ts", "e.buf.fill(0); // zero the parked copy; the caller zeroes its own after use")],
  },
];
