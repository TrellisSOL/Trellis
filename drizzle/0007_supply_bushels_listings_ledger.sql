CREATE TABLE "bushel_allowances" (
	"lot_id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"grade" text NOT NULL,
	"provider_id" text,
	"tokens_granted" bigint NOT NULL,
	"tokens_left" bigint NOT NULL,
	"usable_from" timestamp with time zone NOT NULL,
	"usable_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bushel_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"commitment" text NOT NULL,
	"lot_seq" integer NOT NULL,
	"lot_account" text NOT NULL,
	"operator" text NOT NULL,
	"provider_id" text,
	"key_hash" text NOT NULL,
	"chain_key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"grade" text NOT NULL,
	"tokens" bigint NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"price_paid_usdc" bigint NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"buy_tx" text,
	"redeem_tx" text,
	"redeemed_at" timestamp with time zone,
	"unserved_tokens" bigint DEFAULT 0 NOT NULL,
	"rehomed_to" text,
	"shortfall_tx" text,
	"claim_ref" text,
	"refund_usdc" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bushel_shortfalls" (
	"commitment" text PRIMARY KEY NOT NULL,
	"operator" text NOT NULL,
	"provider_id" text,
	"grade" text NOT NULL,
	"tokens" bigint NOT NULL,
	"sold_tokens" bigint NOT NULL,
	"unserved_tokens" bigint NOT NULL,
	"ok_rate" real,
	"samples" integer DEFAULT 0 NOT NULL,
	"evidence_digest" text NOT NULL,
	"report_tx" text,
	"status" text NOT NULL,
	"examined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"base_model" text,
	"hf_repo" text,
	"declared_licence" text,
	"licence" text,
	"licence_family" text,
	"weights_digest" text NOT NULL,
	"creator_wallet" text,
	"removes_safety" boolean DEFAULT false NOT NULL,
	"decision" text NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"acceptable_use" text[] DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"provider_id" text,
	"eval_score" real,
	"canary_accuracy" real,
	"canary_quant_match" boolean,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fault" text,
	"released_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"listed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "honest_ledger_days" (
	"day" text PRIMARY KEY NOT NULL,
	"payments" integer DEFAULT 0 NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"unique_payers" integer DEFAULT 0 NOT NULL,
	"gross_payments" integer DEFAULT 0 NOT NULL,
	"gross_volume" bigint DEFAULT 0 NOT NULL,
	"excluded_self_dealing" integer DEFAULT 0 NOT NULL,
	"excluded_circular" integer DEFAULT 0 NOT NULL,
	"excluded_below_minimum" integer DEFAULT 0 NOT NULL,
	"excluded_volume" bigint DEFAULT 0 NOT NULL,
	"min_payment" bigint DEFAULT 0 NOT NULL,
	"filter_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"adapter" text NOT NULL,
	"model_id" text NOT NULL,
	"digest" text NOT NULL,
	"external_id" text,
	"provider_id" text NOT NULL,
	"replicas" integer DEFAULT 0 NOT NULL,
	"listed_count" integer DEFAULT 0 NOT NULL,
	"listed_status" text,
	"status" text NOT NULL,
	"lane" text DEFAULT 'open' NOT NULL,
	"hourly_cost" bigint DEFAULT 0 NOT NULL,
	"demand_tokens" bigint DEFAULT 0 NOT NULL,
	"fault" text,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bushel_allowances" ADD CONSTRAINT "bushel_allowances_lot_id_bushel_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."bushel_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bushel_allowances_key_grade_idx" ON "bushel_allowances" USING btree ("key_hash","grade");--> statement-breakpoint
CREATE UNIQUE INDEX "bushel_lots_commitment_seq_uq" ON "bushel_lots" USING btree ("commitment","lot_seq") WHERE "bushel_lots"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "bushel_lots_key_idx" ON "bushel_lots" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "bushel_lots_status_idx" ON "bushel_lots" USING btree ("status","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_listings_model_uq" ON "catalog_listings" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "catalog_listings_status_idx" ON "catalog_listings" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "supply_deployments_status_idx" ON "supply_deployments" USING btree ("status");