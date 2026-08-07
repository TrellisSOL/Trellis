CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"low_balance_pico" bigint,
	"low_balance_alerted" boolean DEFAULT false NOT NULL,
	"inference_keys_default" boolean DEFAULT false NOT NULL,
	"last_sent_week" text,
	"kind" text DEFAULT 'key' NOT NULL,
	"wallet" text,
	"balance" bigint DEFAULT 0 NOT NULL,
	"held" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_action_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"event_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"amount_pico" numeric(78, 0) NOT NULL,
	"details_sha256" text,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome_status" text,
	"outcome_amount_pico" numeric(78, 0),
	"outcome_at" timestamp with time zone,
	CONSTRAINT "agent_action_decisions_amount_check" CHECK ("agent_action_decisions"."amount_pico" >= 0 and ("agent_action_decisions"."outcome_amount_pico" is null or "agent_action_decisions"."outcome_amount_pico" >= 0)),
	CONSTRAINT "agent_action_decisions_decision_check" CHECK ("agent_action_decisions"."decision" in ('allow', 'deny', 'approval_required')),
	CONSTRAINT "agent_action_decisions_outcome_check" CHECK ("agent_action_decisions"."outcome_status" is null or ("agent_action_decisions"."decision" = 'allow' and "agent_action_decisions"."outcome_status" in ('executed', 'skipped', 'failed') and "agent_action_decisions"."outcome_at" is not null and ("agent_action_decisions"."outcome_status" <> 'executed' or "agent_action_decisions"."outcome_amount_pico" is not null)))
);
--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"intent" jsonb NOT NULL,
	"intent_hash" text NOT NULL,
	"max_cost_pico" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "agent_approvals_status_check" CHECK ("agent_approvals"."status" in ('pending', 'approved', 'denied', 'expired', 'used')),
	CONSTRAINT "agent_approvals_cost_check" CHECK ("agent_approvals"."max_cost_pico" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_key_hash" text NOT NULL,
	"reviewer_account_id" text NOT NULL,
	"receipt_kind" text NOT NULL,
	"receipt_id" text NOT NULL,
	"score" integer NOT NULL,
	"tag1" text,
	"tag2" text,
	"paid_pico" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_feedback_score_range" CHECK ("agent_feedback"."score" >= 0 AND "agent_feedback"."score" <= 100),
	CONSTRAINT "agent_feedback_paid_positive" CHECK ("agent_feedback"."paid_pico" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_identities" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"identity_opt_out" boolean,
	"reputation_opt_in" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"mode" text,
	"registry" text,
	"agent_id" text,
	"owner_address" text,
	"tx_hash" text,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_ledger_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" bigint,
	"generation_id" text,
	"approval_id" text
);
--> statement-breakpoint
CREATE TABLE "agent_liveness" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"endpoint_sha256" text NOT NULL,
	"live" boolean NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error" text,
	"probed_at" timestamp with time zone NOT NULL,
	"receipt" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_payments" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"policy_sha256" text NOT NULL,
	"recipient_profile" text,
	"recipient_key_hash" text,
	"recipient_wallet" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"memo_sha256" text,
	"status" text DEFAULT 'awaiting_transfer' NOT NULL,
	"status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tx_hash" text,
	"log_index" integer,
	"block_number" bigint,
	"block_hash" text,
	"payer_wallet" text,
	"paid_units" numeric(78, 0),
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"reason" text,
	"receipt" jsonb,
	"receipt_sig" text,
	"receipt_key_id" text,
	CONSTRAINT "agent_payments_status_check" CHECK ("agent_payments"."status" in ('awaiting_transfer', 'seen', 'final', 'reversed')),
	CONSTRAINT "agent_payments_amount_check" CHECK ("agent_payments"."amount_units" > 0 and ("agent_payments"."paid_units" is null or "agent_payments"."paid_units" >= "agent_payments"."amount_units")),
	CONSTRAINT "agent_payments_transfer_check" CHECK ("agent_payments"."status" = 'awaiting_transfer' or ("agent_payments"."tx_hash" is not null and "agent_payments"."log_index" is not null and "agent_payments"."block_number" is not null and "agent_payments"."block_hash" is not null and "agent_payments"."payer_wallet" is not null and "agent_payments"."paid_units" is not null and "agent_payments"."verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"killed" boolean DEFAULT false NOT NULL,
	"killed_at" timestamp with time zone,
	"killed_reason" text,
	"kill_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"playbook_id" text
);
--> statement-breakpoint
CREATE TABLE "agent_policy_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"decision" text,
	"reasons" jsonb NOT NULL,
	"intent" jsonb,
	"policy_sha256" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"slug" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"settings" jsonb NOT NULL,
	"certificates" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"parent_key_hash" text NOT NULL,
	"key_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"budget" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_track_records" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"certificate" jsonb NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anchors" (
	"index" integer PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attestation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"tee_kind" text,
	"attestation_hash" text,
	"tls_spki_sha256" text,
	"measurements" jsonb,
	"measurement_changed" boolean DEFAULT false NOT NULL,
	"verifiers" jsonb,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"tee_kind" text,
	"report_hash" text,
	"nonce" text,
	"measurements" jsonb,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "batch_lines" (
	"batch_id" text NOT NULL,
	"idx" integer NOT NULL,
	"api" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status_code" integer,
	"generation_id" text,
	"cost" bigint DEFAULT 0 NOT NULL,
	"list_cost" bigint DEFAULT 0 NOT NULL,
	"failure_code" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "batch_lines_batch_id_idx_pk" PRIMARY KEY("batch_id","idx")
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"api" text NOT NULL,
	"status" text DEFAULT 'validating' NOT NULL,
	"total" integer NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"list_cost" bigint DEFAULT 0 NOT NULL,
	"discount_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"cancelling_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"results_expire_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "blind_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"denomination" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"spki" text NOT NULL,
	"private_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"issue_until" timestamp with time zone NOT NULL,
	"redeem_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"issued" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blind_nullifiers" (
	"nullifier" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"spent_at" timestamp with time zone,
	"generation_id" text
);
--> statement-breakpoint
CREATE TABLE "byok_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"key_enc" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canaries" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"quant_match" boolean,
	"quant_guess" text,
	"distance" real,
	"quality" real,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "canary_references" (
	"model_id" text NOT NULL,
	"quant" text NOT NULL,
	"fingerprint" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canary_references_model_id_quant_pk" PRIMARY KEY("model_id","quant")
);
--> statement-breakpoint
CREATE TABLE "chain_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"contract" text NOT NULL,
	"event" text NOT NULL,
	"block_number" bigint NOT NULL,
	"args" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "character_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"bytes" integer NOT NULL,
	"embedding" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_usage" (
	"character_id" text NOT NULL,
	"period" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "character_usage_character_id_period_pk" PRIMARY KEY("character_id","period")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"visibility" text NOT NULL,
	"name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"creator" text,
	"spec" text,
	"card" jsonb,
	"sealed_card" text,
	"card_hash" text NOT NULL,
	"default_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"from_address" text NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"block_hash" text,
	"account_id" text,
	"price18" text,
	"price_updated_at" timestamp with time zone,
	"credited" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credited_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"review_reason" text,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "facilitator_sellers" (
	"id" text PRIMARY KEY NOT NULL,
	"pay_to" text NOT NULL,
	"resource" text NOT NULL,
	"price_hint" numeric(78, 0),
	"result_schema" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"listed" boolean DEFAULT true NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facilitator_settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"payer" text NOT NULL,
	"pay_to" text NOT NULL,
	"value" numeric(78, 0) NOT NULL,
	"nonce" text NOT NULL,
	"tx_hash" text,
	"status" text NOT NULL,
	"error" text,
	"seller_id" text,
	"x402_version" smallint NOT NULL,
	"fee_value" numeric(78, 0),
	"fee_tx_hash" text,
	"gas_debit" numeric(78, 0),
	"settled_at" timestamp with time zone,
	"receipt_cose" text,
	"receipt_leaf" text,
	"receipt_key_id" text,
	"anchor_index" integer,
	"leaf_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilitator_settlements_status" CHECK ("facilitator_settlements"."status" IN ('verified','settled','failed')),
	CONSTRAINT "facilitator_settlements_kind" CHECK ("facilitator_settlements"."kind" IN ('payment','gas_float'))
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"key_hash" text,
	"account_id" text,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"upstream_cost" bigint DEFAULT 0 NOT NULL,
	"royalty" bigint DEFAULT 0 NOT NULL,
	"margin" bigint DEFAULT 0 NOT NULL,
	"cache_discount" bigint DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"latency_ms" integer,
	"generation_time_ms" integer,
	"finish_reason" text,
	"native_finish_reason" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"quant" text,
	"data_region" text,
	"is_byok" boolean DEFAULT false NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"attestation_hash" text,
	"receipt_id" text,
	"receipt_sig" text,
	"receipt_key_id" text,
	"receipt" jsonb,
	"receipt_leaf" text,
	"anchor_index" integer,
	"leaf_index" integer,
	"receipt_v2" jsonb,
	"receipt_cose" text,
	"receipt_leaf_v2" text,
	"leaf_index_v2" integer,
	"paid_with" jsonb,
	"payment_tx" text,
	"app_id" text,
	"attempts" jsonb,
	"request_sha256" text,
	"response_sha256" text,
	"settled_period" text
);
--> statement-breakpoint
CREATE TABLE "health" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"tps" real,
	"empty200" boolean DEFAULT false NOT NULL,
	"status_code" integer,
	"error_kind" text,
	"source" text DEFAULT 'traffic' NOT NULL,
	"caller" text
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"kind" text DEFAULT 'usage' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_anchor_leaves" (
	"provider_id" text NOT NULL,
	"leaf" text NOT NULL,
	"anchor_id" integer NOT NULL,
	"leaf_index" integer NOT NULL,
	"receipt_id" text NOT NULL,
	"receipt_ts" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_anchor_leaves_provider_id_leaf_pk" PRIMARY KEY("provider_id","leaf")
);
--> statement-breakpoint
CREATE TABLE "host_anchors" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"attestation_ref" text NOT NULL,
	"receipt_key_id" text NOT NULL,
	"receipt_public_key" text NOT NULL,
	"root" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"chain_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_policies" (
	"version" integer PRIMARY KEY NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"canonical" text NOT NULL,
	"sha256" text NOT NULL,
	"signature" text NOT NULL,
	"verifier_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_policies_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "key_topups" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"outcome" text NOT NULL,
	"amount_pico" bigint NOT NULL,
	"limit_before_pico" bigint NOT NULL,
	"limit_after_pico" bigint NOT NULL,
	"spent_pico" bigint NOT NULL,
	"available_pico" bigint NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"week_total_pico" bigint NOT NULL,
	"max_per_week_pico" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"chain_key_hash" text NOT NULL,
	"key_address" text NOT NULL,
	"account_id" text NOT NULL,
	"parent_hash" text,
	"name" text DEFAULT '' NOT NULL,
	"label" text NOT NULL,
	"budget" bigint,
	"budget_reset" text,
	"period_start" timestamp with time zone,
	"spent" bigint DEFAULT 0 NOT NULL,
	"spent_total" bigint DEFAULT 0 NOT NULL,
	"rpm" integer,
	"tpm" integer,
	"team_id" text,
	"allowed_models" text[],
	"pay_with_default" text,
	"scope" text,
	"include_byok_in_limit" boolean DEFAULT false NOT NULL,
	"management" boolean DEFAULT false NOT NULL,
	"routing" jsonb,
	"guardrails" jsonb,
	"tracing" jsonb,
	"topup" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone,
	CONSTRAINT "keys_scope_valid" CHECK ("keys"."scope" IS NULL OR "keys"."scope" = 'inference'),
	CONSTRAINT "keys_scope_management" CHECK ("keys"."scope" IS DISTINCT FROM 'inference' OR "keys"."management" = false)
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"weekly_summary_opted_in" boolean,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"hf_repo" text NOT NULL,
	"base_model" text NOT NULL,
	"revision" text,
	"license" text,
	"variant" text DEFAULT 'abliterated' NOT NULL,
	"creator_handle" text NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"reason" text,
	"model_id" text,
	"endpoint_provider" text,
	"source_created_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"servable_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"hf_repo" text NOT NULL,
	"handle" text NOT NULL,
	"address" text NOT NULL,
	"challenge" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"onchain_tx" text
);
--> statement-breakpoint
CREATE TABLE "lane_evals" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"refusal_rate" real,
	"capability_score" real,
	"canary_accuracy" real,
	"canary_quant_match" boolean,
	"passed" boolean NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"amount" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"generation_id" text,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "makegood_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"payer" text NOT NULL,
	"usdc" bigint NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"tx_hash" text NOT NULL,
	"signed_tx_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "makegood_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"generation_id" text,
	"account_id" text NOT NULL,
	"key_hash" text,
	"rule" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"charged" bigint DEFAULT 0 NOT NULL,
	"evidence" jsonb NOT NULL,
	"provider_id" text,
	"strike" boolean DEFAULT false NOT NULL,
	"payer" text,
	"onchain_usdc" bigint,
	"payout_status" text DEFAULT 'none' NOT NULL,
	"payout_id" text,
	"receipt" jsonb,
	"receipt_sig" text,
	"receipt_key_id" text,
	"receipt_leaf" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "measurement_bundles" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"compose_hash" text NOT NULL,
	"bundle_digest" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"signature" text NOT NULL,
	"signer_key_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rekor_uuid" text,
	"rekor_entry" text,
	"rekor_log_index" bigint,
	"rekor_integrated_at" timestamp with time zone,
	"rekor_entry_json" jsonb,
	"rekor_inclusion_verified" boolean DEFAULT false NOT NULL,
	"rekor_checkpoint_verified" boolean DEFAULT false NOT NULL,
	"rekor_set_verified" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"image_digest" text NOT NULL,
	"compose_hash" text NOT NULL,
	"model_digest" text NOT NULL,
	"status" text DEFAULT 'observed' NOT NULL,
	"verifier" text NOT NULL,
	"tee_kind" text,
	"quote" text NOT NULL,
	"quote_proof_hash" text NOT NULL,
	"report_hash" text,
	"attested_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rekor_uuid" text,
	"rekor_entry" text,
	"rekor_log_index" bigint,
	"rekor_kind" text,
	"rekor_integrated_at" timestamp with time zone,
	"rekor_inclusion_verified" boolean DEFAULT false NOT NULL,
	"rekor_checkpoint_verified" boolean DEFAULT false NOT NULL,
	"rekor_checked_at" timestamp with time zone,
	"rekor_error" text,
	"calldata" text,
	"calldata_target" text,
	"calldata_built_at" timestamp with time zone,
	"tx_hash" text,
	"registered_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"superseded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ctx" integer DEFAULT 8192 NOT NULL,
	"max_out" integer,
	"arch" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hf_repo" text,
	"creator" text,
	"royalty_bps" integer DEFAULT 0 NOT NULL,
	"created_unix" integer NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models_lane" (
	"model_id" text PRIMARY KEY NOT NULL,
	"variant" text DEFAULT 'mainstream' NOT NULL,
	"status" text DEFAULT 'servable' NOT NULL,
	"base_model" text,
	"license" text,
	"weights_source" text,
	"weights_revision" text,
	"weights_digest" text,
	"creator_handle" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_fee_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"period" text NOT NULL,
	"gross_pico" numeric(78, 0) NOT NULL,
	"fee_pico" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"swap_tx" text,
	"burn_tx" text,
	"trls_amount" numeric(78, 0),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_fee_status" CHECK ("network_fee_ledger"."status" in ('accrued','swapped','burned')),
	CONSTRAINT "network_fee_amounts" CHECK ("network_fee_ledger"."gross_pico" >= 0 and "network_fee_ledger"."fee_pico" >= 0 and "network_fee_ledger"."fee_pico" <= "network_fee_ledger"."gross_pico")
);
--> statement-breakpoint
CREATE TABLE "network_payout_dispatch" (
	"payout_id" text PRIMARY KEY NOT NULL,
	"signed_tx_enc" text NOT NULL,
	"tx_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_receipt_links" (
	"generation_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"accrued_period" text
);
--> statement-breakpoint
CREATE TABLE "network_waitlist" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"hardware" text NOT NULL,
	"readiness" text NOT NULL,
	"region" text NOT NULL,
	"contact" text,
	"paid_in" text NOT NULL,
	"delete_code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_role" CHECK ("network_waitlist"."role" in ('host_gpu','host_cpu','relay','witness','developer')),
	CONSTRAINT "network_region" CHECK ("network_waitlist"."region" in ('africa','antarctica','asia','europe','north_america','oceania','south_america')),
	CONSTRAINT "network_paid_in" CHECK ("network_waitlist"."paid_in" in ('usdc','trls','any')),
	CONSTRAINT "network_lengths" CHECK (char_length("network_waitlist"."hardware") <= 200 and char_length("network_waitlist"."readiness") <= 300 and char_length("network_waitlist"."contact") <= 120 and char_length("network_waitlist"."delete_code_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"price_prompt" bigint NOT NULL,
	"price_completion" bigint NOT NULL,
	"price_request" bigint DEFAULT 0 NOT NULL,
	"price_image" bigint DEFAULT 0 NOT NULL,
	"price_web_search" bigint DEFAULT 0 NOT NULL,
	"price_reasoning" bigint DEFAULT 0 NOT NULL,
	"price_cache_read" bigint,
	"price_cache_write" bigint,
	"quant" text DEFAULT 'unknown' NOT NULL,
	"ctx" integer,
	"max_out" integer,
	"supported_parameters" text[] DEFAULT '{}' NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_moderated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_model_id_provider_id_pk" PRIMARY KEY("model_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "ohttp_keys" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"key_id" integer NOT NULL,
	"kem_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"config" text NOT NULL,
	"config_sha256" text NOT NULL,
	"private_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"accept_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"usdc" bigint NOT NULL,
	"to" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_debts" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"token" text NOT NULL,
	"amount" bigint NOT NULL,
	"raw_estimate" bigint,
	"fair_price18" text,
	"swap_id" text,
	"raw_allocated" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_sessions" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"token" text NOT NULL,
	"symbol" text NOT NULL,
	"cap_raw_day" bigint NOT NULL,
	"spent_raw_today" bigint DEFAULT 0 NOT NULL,
	"day_start" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"opened_tx" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paywith_swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"token" text NOT NULL,
	"raw_spent" bigint,
	"fair_price" text,
	"usdc_out" bigint NOT NULL,
	"tx" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"allocations" jsonb
);
--> statement-breakpoint
CREATE TABLE "playbook_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"playbook_id" text NOT NULL,
	"account_id" text NOT NULL,
	"team_id" text,
	"name" text NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"spec" jsonb NOT NULL,
	"followers" integer NOT NULL,
	"actor" text NOT NULL,
	"notify" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_changes_action_check" CHECK ("playbook_changes"."action" in ('create', 'update', 'rename', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"team_id" text,
	"name" text NOT NULL,
	"spec" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "playbooks_version_check" CHECK ("playbooks"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "preset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"source" text DEFAULT 'put' NOT NULL,
	"restored_from" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_disclosure" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"retention" text DEFAULT 'logs' NOT NULL,
	"jurisdiction" text DEFAULT 'unknown' NOT NULL,
	"legal_hold" boolean,
	"legal_hold_note" text,
	"training_use" text DEFAULT 'unknown' NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"network_host" boolean DEFAULT false NOT NULL,
	"network_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"network_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text,
	"kind" text DEFAULT 'openai' NOT NULL,
	"headers" jsonb,
	"data_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"datacenter" text[],
	"attested" boolean DEFAULT false NOT NULL,
	"attestation_url" text,
	"attestation_hash" text,
	"attested_at" timestamp with time zone,
	"tee_kind" text,
	"classifier_enabled" boolean DEFAULT false NOT NULL,
	"bond_usdc" bigint DEFAULT 0 NOT NULL,
	"trls_stake" bigint DEFAULT 0 NOT NULL,
	"operator" text,
	"payout_mode" text DEFAULT 'invoice' NOT NULL,
	"payout_address" text,
	"status" text DEFAULT 'applied' NOT NULL,
	"shadow_until" timestamp with time zone,
	"timeout_ms" integer,
	"static_models" jsonb,
	"contact" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"nonce" text PRIMARY KEY NOT NULL,
	"price_usdc" bigint NOT NULL,
	"price_pico" bigint NOT NULL,
	"request_sha256" text NOT NULL,
	"model_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payer" text,
	"tx_hash" text,
	"account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" text,
	"valid_from" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"onchain_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalties" (
	"model_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" bigint NOT NULL,
	"usdc" bigint NOT NULL,
	"creator" text,
	"stream_tx" text,
	"claimed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "royalties_model_id_period_pk" PRIMARY KEY("model_id","period")
);
--> statement-breakpoint
CREATE TABLE "sanctions_addresses" (
	"address" text PRIMARY KEY NOT NULL,
	"list_date" timestamp with time zone NOT NULL,
	"source_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions_meta" (
	"id" integer PRIMARY KEY NOT NULL,
	"list_date" timestamp with time zone NOT NULL,
	"source_hash" text NOT NULL,
	"entry_count" integer NOT NULL,
	"ignored_count" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_gas_floats" (
	"seller_id" text PRIMARY KEY NOT NULL,
	"balance" numeric(78, 0) DEFAULT 0 NOT NULL,
	"funded" numeric(78, 0) DEFAULT 0 NOT NULL,
	"debited" numeric(78, 0) DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_gas_floats_balance" CHECK ("seller_gas_floats"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"provider_id" text NOT NULL,
	"period" text NOT NULL,
	"tokens" bigint NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"upstream" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"usdc_owed" bigint NOT NULL,
	"payout_id" text,
	"paid_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_provider_id_period_pk" PRIMARY KEY("provider_id","period")
);
--> statement-breakpoint
CREATE TABLE "skill_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"price_usdc" bigint NOT NULL,
	"author_share" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"author" text NOT NULL,
	"account_id" text,
	"created_by" text,
	"source" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"tar_sha256" text NOT NULL,
	"archive" text NOT NULL,
	"size" integer NOT NULL,
	"file_count" integer NOT NULL,
	"level" text NOT NULL,
	"score" integer NOT NULL,
	"report" jsonb NOT NULL,
	"price_usdc" bigint DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slashes" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text,
	"kind" text NOT NULL,
	"amount_usdc" bigint NOT NULL,
	"delist" boolean DEFAULT false NOT NULL,
	"evidence_root" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executable_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"dispute_hash" text,
	"disputed_at" timestamp with time zone,
	"onchain_id" text,
	"tx_hash" text,
	"refunded" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"key_hash" text,
	"kind" text NOT NULL,
	"window" text DEFAULT 'day' NOT NULL,
	"threshold" bigint,
	"pct" integer,
	"webhook_url_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_period" text,
	"state" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spent_roots" (
	"epoch" integer PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"total_spent_usdc" bigint NOT NULL,
	"leaves" jsonb NOT NULL,
	"tx_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_dp_hours" (
	"instance" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"epsilon" real NOT NULL,
	"counts" jsonb NOT NULL,
	CONSTRAINT "status_dp_hours_instance_hour_pk" PRIMARY KEY("instance","hour")
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"impact" text DEFAULT 'minor' NOT NULL,
	"lanes" jsonb NOT NULL,
	"surfaces" jsonb NOT NULL,
	"source" text NOT NULL,
	"updates" jsonb NOT NULL,
	"evidence" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_windows" (
	"surface" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"ok" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"latency" integer[] NOT NULL,
	CONSTRAINT "status_windows_surface_bucket_pk" PRIMARY KEY("surface","bucket")
);
--> statement-breakpoint
CREATE TABLE "team_audit" (
	"team_id" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "team_audit_team_id_seq_pk" PRIMARY KEY("team_id","seq")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_key_hash_pk" PRIMARY KEY("team_id","key_hash")
);
--> statement-breakpoint
CREATE TABLE "team_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"public_key" text,
	"alg" integer,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_account" text NOT NULL,
	"owner_address" text,
	"owner_kind" text DEFAULT 'account' NOT NULL,
	"owner_verified_at" timestamp with time zone,
	"budget" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlog_checkpoints" (
	"size" bigint PRIMARY KEY NOT NULL,
	"root_hash" text NOT NULL,
	"checkpoint" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlog_cosignatures" (
	"size" bigint NOT NULL,
	"witness" text NOT NULL,
	"key_id" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tlog_cosignatures_size_witness_key_id_pk" PRIMARY KEY("size","witness","key_id")
);
--> statement-breakpoint
CREATE TABLE "tlog_entries" (
	"idx" bigint PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"subject" text NOT NULL,
	"entry" text NOT NULL,
	"leaf_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlog_rekor_anchors" (
	"id" serial PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"root_hash" text NOT NULL,
	"note" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"key_id" text NOT NULL,
	"rekor_url" text NOT NULL,
	"uuid" text NOT NULL,
	"status" text NOT NULL,
	"log_index" bigint,
	"integrated_time" bigint,
	"log_id" text,
	"entry_base64" text,
	"inclusion_proof" jsonb,
	"signed_entry_timestamp" text,
	"checkpoint_verified" boolean DEFAULT false NOT NULL,
	"set_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"account_id" text NOT NULL,
	"seller_id" text,
	"pay_to" text NOT NULL,
	"resource" text NOT NULL,
	"method" text NOT NULL,
	"network" text NOT NULL,
	"x402_version" integer NOT NULL,
	"price_units" bigint NOT NULL,
	"price" bigint NOT NULL,
	"take" bigint NOT NULL,
	"hold_id" text NOT NULL,
	"payer" text NOT NULL,
	"nonce" text NOT NULL,
	"valid_before" timestamp with time zone NOT NULL,
	"settle_tx" text,
	"response_sha256" text,
	"seller_status" integer,
	"status" text NOT NULL,
	"failure" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "tool_calls_status_valid" CHECK ("tool_calls"."status" in ('paying','ok','failed','released','charged_after_failure')),
	CONSTRAINT "tool_calls_amounts_valid" CHECK ("tool_calls"."price_units" > 0 and "tool_calls"."price" >= 0 and "tool_calls"."take" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tool_canary_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"failure" text,
	"price_units" bigint,
	"settle_tx" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_by" text NOT NULL,
	"skill_id" text,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"resource" text NOT NULL,
	"method" text NOT NULL,
	"price_units" bigint NOT NULL,
	"pay_to" text NOT NULL,
	"network" text NOT NULL,
	"canary" jsonb NOT NULL,
	"status" text DEFAULT 'listed' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"delisted_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_listings_status_valid" CHECK ("tool_listings"."status" in ('listed','delisted','removed')),
	CONSTRAINT "tool_listings_method_valid" CHECK ("tool_listings"."method" in ('GET','POST')),
	CONSTRAINT "tool_listings_price_positive" CHECK ("tool_listings"."price_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"destination_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event" text NOT NULL,
	"reference" text NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"event_status" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"attempted_at" timestamp with time zone,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_by" text NOT NULL,
	"key_hash" text,
	"rule_id" text,
	"url_enc" text NOT NULL,
	"secret_enc" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"events" jsonb NOT NULL,
	"scan" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x402_paid_results" (
	"payer" text NOT NULL,
	"nonce" text NOT NULL,
	"request_sha256" text NOT NULL,
	"response_sha256" text NOT NULL,
	"body_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "x402_paid_results_payer_nonce_pk" PRIMARY KEY("payer","nonce")
);
--> statement-breakpoint
CREATE TABLE "low_balance_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"balance_pico" bigint NOT NULL,
	"threshold_pico" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_bond_cursor" (
	"scope" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text,
	"checkpoints" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_bond_events" (
	"scope" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"event" text NOT NULL,
	"args" jsonb NOT NULL,
	CONSTRAINT "host_bond_events_scope_tx_hash_log_index_pk" PRIMARY KEY("scope","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "host_bond_projection" (
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "host_bond_projection_scope_kind_id_pk" PRIMARY KEY("scope","kind","id")
);
--> statement-breakpoint
CREATE TABLE "host_slash_evidence" (
	"scope" text NOT NULL,
	"root" text NOT NULL,
	"provider_id" text NOT NULL,
	"host_id" text NOT NULL,
	"canonical" text NOT NULL,
	"reason" integer NOT NULL,
	"amount" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"proposal_tx" text,
	"proposal_raw" text,
	"execution_tx" text,
	"execution_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_slash_evidence_scope_root_pk" PRIMARY KEY("scope","root")
);
--> statement-breakpoint
ALTER TABLE "agent_action_decisions" ADD CONSTRAINT "agent_action_decisions_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_feedback" ADD CONSTRAINT "agent_feedback_subject_key_hash_keys_key_hash_fk" FOREIGN KEY ("subject_key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ledger_links" ADD CONSTRAINT "agent_ledger_links_event_id_agent_policy_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."agent_policy_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_liveness" ADD CONSTRAINT "agent_liveness_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_decision_id_agent_action_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_action_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_payments" ADD CONSTRAINT "agent_payments_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_policies" ADD CONSTRAINT "agent_policies_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_track_records" ADD CONSTRAINT "agent_track_records_key_hash_keys_key_hash_fk" FOREIGN KEY ("key_hash") REFERENCES "public"."keys"("key_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makegood_refunds" ADD CONSTRAINT "makegood_refunds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "makegood_refunds" ADD CONSTRAINT "makegood_refunds_payout_id_makegood_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."makegood_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_gas_floats" ADD CONSTRAINT "seller_gas_floats_seller_id_facilitator_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."facilitator_sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_canary_runs" ADD CONSTRAINT "tool_canary_runs_seller_id_tool_listings_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."tool_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_listings" ADD CONSTRAINT "tool_listings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_listings" ADD CONSTRAINT "tool_listings_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_destination_id_webhook_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."webhook_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_created_by_keys_key_hash_fk" FOREIGN KEY ("created_by") REFERENCES "public"."keys"("key_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_destinations" ADD CONSTRAINT "webhook_destinations_rule_id_spend_alerts_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."spend_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_wallet_uq" ON "accounts" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "agent_action_decisions_key_created_idx" ON "agent_action_decisions" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "agent_approvals_key_status_idx" ON "agent_approvals" USING btree ("key_hash","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_feedback_receipt_uq" ON "agent_feedback" USING btree ("receipt_kind","receipt_id");--> statement-breakpoint
CREATE INDEX "agent_feedback_subject_idx" ON "agent_feedback" USING btree ("subject_key_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_id_uq" ON "agent_identities" USING btree ("id");--> statement-breakpoint
CREATE INDEX "agent_ledger_links_key_request_idx" ON "agent_ledger_links" USING btree ("key_hash","request_id");--> statement-breakpoint
CREATE INDEX "agent_ledger_links_ts_idx" ON "agent_ledger_links" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ledger_links_event_uq" ON "agent_ledger_links" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ledger_links_generation_uq" ON "agent_ledger_links" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_payments_transfer_uq" ON "agent_payments" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "agent_payments_account_status_idx" ON "agent_payments" USING btree ("account_id","status_at");--> statement-breakpoint
CREATE INDEX "agent_payments_recipient_status_idx" ON "agent_payments" USING btree ("recipient_key_hash","status_at");--> statement-breakpoint
CREATE INDEX "agent_payments_status_idx" ON "agent_payments" USING btree ("status","block_number");--> statement-breakpoint
CREATE INDEX "agent_policies_playbook_idx" ON "agent_policies" USING btree ("playbook_id") WHERE "agent_policies"."playbook_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_policy_events_key_idx" ON "agent_policy_events" USING btree ("key_hash","id");--> statement-breakpoint
CREATE INDEX "agent_policy_events_ts_idx" ON "agent_policy_events" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_key_uq" ON "agent_profiles" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_key_uq" ON "agent_sessions" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "agent_sessions_account_idx" ON "agent_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "agent_track_records_key_idx" ON "agent_track_records" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "attestation_events_provider_ts_idx" ON "attestation_events" USING btree ("provider_id","ts","id");--> statement-breakpoint
CREATE INDEX "attestation_events_ts_idx" ON "attestation_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "attestations_provider_ts" ON "attestations" USING btree ("provider_id","ts");--> statement-breakpoint
CREATE INDEX "batch_lines_queue_idx" ON "batch_lines" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "batches_key_created_idx" ON "batches" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blind_keys_epoch_denomination_uq" ON "blind_keys" USING btree ("epoch","denomination");--> statement-breakpoint
CREATE INDEX "blind_nullifiers_key_idx" ON "blind_nullifiers" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "byok_account_provider_uq" ON "byok_keys" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE INDEX "canaries_mp_ts_idx" ON "canaries" USING btree ("model_id","provider_id","ts");--> statement-breakpoint
CREATE INDEX "chain_events_unprocessed" ON "chain_events" USING btree ("processed","event");--> statement-breakpoint
CREATE INDEX "character_memory_account_scope_idx" ON "character_memory" USING btree ("account_id","scope");--> statement-breakpoint
CREATE INDEX "characters_account_idx" ON "characters" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "characters_visibility_idx" ON "characters" USING btree ("visibility","updated_at");--> statement-breakpoint
CREATE INDEX "escrow_deposits_from_idx" ON "escrow_deposits" USING btree ("from_address");--> statement-breakpoint
CREATE INDEX "escrow_deposits_status_idx" ON "escrow_deposits" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "facilitator_sellers_resource_uq" ON "facilitator_sellers" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "facilitator_sellers_pay_to_idx" ON "facilitator_sellers" USING btree ("pay_to");--> statement-breakpoint
CREATE UNIQUE INDEX "facilitator_settlements_payer_nonce_uq" ON "facilitator_settlements" USING btree ("payer","nonce");--> statement-breakpoint
CREATE INDEX "facilitator_settlements_anchor_idx" ON "facilitator_settlements" USING btree ("anchor_index");--> statement-breakpoint
CREATE INDEX "facilitator_settlements_pay_to_idx" ON "facilitator_settlements" USING btree ("pay_to");--> statement-breakpoint
CREATE INDEX "gen_ts_idx" ON "generations" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "gen_key_ts_idx" ON "generations" USING btree ("key_hash","ts");--> statement-breakpoint
CREATE INDEX "gen_provider_ts_idx" ON "generations" USING btree ("provider_id","ts");--> statement-breakpoint
CREATE INDEX "gen_anchor_idx" ON "generations" USING btree ("anchor_index");--> statement-breakpoint
CREATE INDEX "health_mp_ts_idx" ON "health" USING btree ("model_id","provider_id","ts");--> statement-breakpoint
CREATE INDEX "holds_account_status_idx" ON "holds" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "holds_expiry_idx" ON "holds" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "host_anchor_leaves_leaf_idx" ON "host_anchor_leaves" USING btree ("leaf");--> statement-breakpoint
CREATE UNIQUE INDEX "host_anchor_leaves_position_idx" ON "host_anchor_leaves" USING btree ("anchor_id","leaf_index");--> statement-breakpoint
CREATE INDEX "host_anchors_provider_idx" ON "host_anchors" USING btree ("provider_id","to_ts");--> statement-breakpoint
CREATE INDEX "host_anchors_status_idx" ON "host_anchors" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "key_topups_ref_uq" ON "key_topups" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "key_topups_key_created_idx" ON "key_topups" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keys_chain_uq" ON "keys" USING btree ("chain_key_hash");--> statement-breakpoint
CREATE INDEX "keys_account_idx" ON "keys" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_candidates_repo_uq" ON "lane_candidates" USING btree ("hf_repo");--> statement-breakpoint
CREATE INDEX "lane_candidates_status_idx" ON "lane_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "lane_claims_model_idx" ON "lane_claims" USING btree ("model_id","created_at");--> statement-breakpoint
CREATE INDEX "lane_evals_candidate_idx" ON "lane_evals" USING btree ("candidate_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_ref_uq" ON "ledger" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "makegood_payouts_tx_uq" ON "makegood_payouts" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "makegood_payouts_status_idx" ON "makegood_payouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "makegood_refunds_source_uq" ON "makegood_refunds" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "makegood_refunds_status_idx" ON "makegood_refunds" USING btree ("status","detected_at");--> statement-breakpoint
CREATE INDEX "makegood_refunds_account_idx" ON "makegood_refunds" USING btree ("account_id","detected_at");--> statement-breakpoint
CREATE INDEX "makegood_refunds_payout_idx" ON "makegood_refunds" USING btree ("payout_status","payer");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_bundles_provider_digest_uq" ON "measurement_bundles" USING btree ("provider_id","bundle_digest");--> statement-breakpoint
CREATE INDEX "measurement_bundles_compose_idx" ON "measurement_bundles" USING btree ("provider_id","compose_hash");--> statement-breakpoint
CREATE INDEX "measurement_bundles_status_idx" ON "measurement_bundles" USING btree ("status","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "measurements_provider_image_compose_uq" ON "measurements" USING btree ("provider_id","image_digest","compose_hash");--> statement-breakpoint
CREATE INDEX "measurements_status_idx" ON "measurements" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "network_fee_period_uq" ON "network_fee_ledger" USING btree ("provider_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "network_receipt_once_uq" ON "network_receipt_links" USING btree ("provider_id","receipt_id");--> statement-breakpoint
CREATE INDEX "offers_provider_idx" ON "offers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "ohttp_keys_key_id_idx" ON "ohttp_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "paywith_debts_open_idx" ON "paywith_debts" USING btree ("chain_key_hash","swap_id");--> statement-breakpoint
CREATE INDEX "playbook_changes_playbook_idx" ON "playbook_changes" USING btree ("playbook_id","id");--> statement-breakpoint
CREATE INDEX "playbook_changes_account_at_idx" ON "playbook_changes" USING btree ("account_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_account_name_uq" ON "playbooks" USING btree ("account_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "preset_versions_account_name_version_uq" ON "preset_versions" USING btree ("account_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_network_wallet_endpoint_uq" ON "providers" USING btree ("operator","base_url") WHERE "providers"."network_host" = true;--> statement-breakpoint
CREATE INDEX "quotes_tx_idx" ON "quotes" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_routes_account_slug_uq" ON "saved_routes" USING btree ("account_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_installs_skill_account_uq" ON "skill_installs" USING btree ("skill_id","account_id");--> statement-breakpoint
CREATE INDEX "skill_installs_account_idx" ON "skill_installs" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tar_sha256_uq" ON "skills" USING btree ("tar_sha256");--> statement-breakpoint
CREATE INDEX "skills_slug_idx" ON "skills" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "skills_level_idx" ON "skills" USING btree ("level");--> statement-breakpoint
CREATE INDEX "spend_alerts_account_idx" ON "spend_alerts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "status_dp_hours_hour_idx" ON "status_dp_hours" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "status_incidents_started_idx" ON "status_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "status_windows_bucket_idx" ON "status_windows" USING btree ("bucket");--> statement-breakpoint
CREATE UNIQUE INDEX "team_principals_team_kind_subject_uq" ON "team_principals" USING btree ("team_id","kind","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "tlog_entries_kind_sha256_uq" ON "tlog_entries" USING btree ("kind","sha256");--> statement-breakpoint
CREATE INDEX "tlog_entries_subject_idx" ON "tlog_entries" USING btree ("kind","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "tlog_rekor_anchors_uuid_uq" ON "tlog_rekor_anchors" USING btree ("rekor_url","uuid");--> statement-breakpoint
CREATE INDEX "tlog_rekor_anchors_status_size_idx" ON "tlog_rekor_anchors" USING btree ("status","size");--> statement-breakpoint
CREATE INDEX "tool_calls_key_idx" ON "tool_calls" USING btree ("key_hash","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_status_idx" ON "tool_calls" USING btree ("status","valid_before");--> statement-breakpoint
CREATE INDEX "tool_calls_created_idx" ON "tool_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tool_canary_runs_seller_idx" ON "tool_canary_runs" USING btree ("seller_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_listings_resource_uq" ON "tool_listings" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "tool_listings_status_idx" ON "tool_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tool_listings_skill_idx" ON "tool_listings" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("destination_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt");--> statement-breakpoint
CREATE INDEX "webhook_destinations_account_idx" ON "webhook_destinations" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_destinations_rule_idx" ON "webhook_destinations" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "x402_paid_results_created_idx" ON "x402_paid_results" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "low_balance_alerts_account_at_idx" ON "low_balance_alerts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "host_bond_events_order" ON "host_bond_events" USING btree ("scope","block","log_index");