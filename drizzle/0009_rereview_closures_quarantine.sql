CREATE TABLE "indexer_quarantine" (
	"contract" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"reason" text NOT NULL,
	"real" boolean,
	"vault_delta" numeric(78, 0),
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "indexer_quarantine_contract_signature_pk" PRIMARY KEY("contract","signature")
);
--> statement-breakpoint
ALTER TABLE "credit_closures" DROP CONSTRAINT "credit_closures_status";--> statement-breakpoint
ALTER TABLE "credit_closures" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "credit_closures" ADD COLUMN "ledger_bound" boolean;--> statement-breakpoint
ALTER TABLE "credit_closures" ADD COLUMN "cancel_tx" text;--> statement-breakpoint
ALTER TABLE "credit_closures" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "indexer_quarantine_open_idx" ON "indexer_quarantine" USING btree ("contract","resolved_at","next_retry_at");--> statement-breakpoint
ALTER TABLE "credit_closures" ADD CONSTRAINT "credit_closures_status" CHECK ("credit_closures"."status" IN ('queued','registered','paid','refused','failed','cancelled'));