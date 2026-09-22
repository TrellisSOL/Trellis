import { boolean, index, integer, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Auto-listing candidates (src/catalog/auto-list.ts): one row per model submitted for listing, with the licence
// decision, the evaluation result and when it was listed.
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const catalogListings = pgTable(
  "catalog_listings",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    baseModel: text("base_model"),
    hfRepo: text("hf_repo"), // the repository the weights were published in, when there is one
    declaredLicence: text("declared_licence"), // as submitted
    licence: text("licence"), // the licence table entry that governs the listing; null when the table does not know it
    licenceFamily: text("licence_family"), // permissive | gemma | llama
    weightsDigest: text("weights_digest").notNull(), // sha256:<hex> of the weights
    creatorWallet: text("creator_wallet"), // where the creator share goes once listed
    removesSafety: boolean("removes_safety").notNull().default(false),
    decision: text("decision").notNull(), // list | needs_review | blocked: what the licence rule said at submission
    reasons: text("reasons").array().notNull().default([]),
    acceptableUse: text("acceptable_use").array().notNull().default([]), // the vendor's acceptable-use flags the listing carries
    status: text("status").notNull(), // submitted | needs_review | approved | listed | blocked
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    providerId: text("provider_id"), // the endpoint the last evaluation ran against
    evalScore: real("eval_score"),
    canaryAccuracy: real("canary_accuracy"),
    canaryQuantMatch: boolean("canary_quant_match"),
    attempts: integer("attempts").notNull().default(0),
    fault: text("fault"), // why the last attempt did not list it: no_endpoint | eval_failed | canary_failed | share_failed
    releasedAt: ts("released_at").notNull(), // when the weights were released; the 24-hour target runs from here
    dueAt: ts("due_at").notNull(),
    listedAt: ts("listed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("catalog_listings_model_uq").on(t.modelId), index("catalog_listings_status_idx").on(t.status, t.dueAt)],
);
