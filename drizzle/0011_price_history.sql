CREATE TABLE "price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"price_prompt" bigint NOT NULL,
	"price_completion" bigint NOT NULL,
	"providers" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "price_snapshots_model_at_idx" ON "price_snapshots" USING btree ("model_id","at");