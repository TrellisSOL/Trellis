CREATE TABLE "holder_polls" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"options" text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closes_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"results" jsonb
);
--> statement-breakpoint
CREATE TABLE "holder_votes" (
	"poll_id" text NOT NULL,
	"wallet" text NOT NULL,
	"choice" text NOT NULL,
	"tier" text NOT NULL,
	"weight" integer NOT NULL,
	"closing_tier" text,
	"closing_weight" integer,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holder_votes_poll_id_wallet_pk" PRIMARY KEY("poll_id","wallet")
);
--> statement-breakpoint
CREATE TABLE "model_early_access" (
	"model_id" text PRIMARY KEY NOT NULL,
	"listed_at" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holder_votes" ADD CONSTRAINT "holder_votes_poll_id_holder_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."holder_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holder_polls_status_idx" ON "holder_polls" USING btree ("status","created_at");