CREATE TABLE "hvx_points" (
	"grade" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"usd_per_mtoken" real,
	"thin" boolean DEFAULT true NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"daily_volume" bigint DEFAULT 0 NOT NULL,
	"published_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hvx_points_grade_hour_pk" PRIMARY KEY("grade","hour")
);
--> statement-breakpoint
CREATE TABLE "shadow_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"host_a" text NOT NULL,
	"host_b" text NOT NULL,
	"digest" text NOT NULL,
	"seed" integer,
	"hash_a" text NOT NULL,
	"hash_b" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"model_id" text NOT NULL,
	"digest" text NOT NULL,
	"seed" integer,
	"host_a" text NOT NULL,
	"host_b" text,
	"status" text NOT NULL,
	"hash_a" text,
	"hash_b" text,
	"cost" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slash_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text,
	"reason" text NOT NULL,
	"bps" integer NOT NULL,
	"delist" boolean DEFAULT false NOT NULL,
	"evidence_root" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"slash_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"picked_up_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "hvx_points_hour_idx" ON "hvx_points" USING btree ("hour");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_evidence_generation_uq" ON "shadow_evidence" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "shadow_evidence_host_idx" ON "shadow_evidence" USING btree ("host_a","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_runs_generation_uq" ON "shadow_runs" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "shadow_runs_host_idx" ON "shadow_runs" USING btree ("host_a","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slash_evidence_root_uq" ON "slash_evidence" USING btree ("provider_id","reason","evidence_root");--> statement-breakpoint
CREATE INDEX "slash_evidence_status_idx" ON "slash_evidence" USING btree ("status","created_at");