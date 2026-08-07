CREATE TABLE "credit_closures" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"chain_key_hash" text NOT NULL,
	"key_address" text NOT NULL,
	"refund_to" text NOT NULL,
	"signature" text NOT NULL,
	"amount" numeric(78, 0),
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"register_tx" text,
	"pay_tx" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payable_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "credit_closures_status" CHECK ("credit_closures"."status" IN ('queued','registered','paid','refused','failed'))
);
--> statement-breakpoint
CREATE TABLE "fee_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"workers" numeric(78, 0) NOT NULL,
	"treasury" numeric(78, 0) NOT NULL,
	"tx" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facilitator_settlements" ADD COLUMN "scheme" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_closures_key_open_uq" ON "credit_closures" USING btree ("chain_key_hash") WHERE "credit_closures"."status" IN ('queued','registered');--> statement-breakpoint
CREATE INDEX "credit_closures_due_idx" ON "credit_closures" USING btree ("status","payable_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_distributions_period_uq" ON "fee_distributions" USING btree ("period");