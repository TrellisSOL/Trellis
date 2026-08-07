CREATE TABLE "service_fees" (
	"id" text PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"role" text NOT NULL,
	"address" text NOT NULL,
	"usdc" numeric(78, 0) NOT NULL,
	"tx" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "service_fees_status" CHECK ("service_fees"."status" IN ('pending','paid','refused','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "service_fees_period_recipient_uq" ON "service_fees" USING btree ("period","role","address");--> statement-breakpoint
CREATE INDEX "service_fees_status_idx" ON "service_fees" USING btree ("status");